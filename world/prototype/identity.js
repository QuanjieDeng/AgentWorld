// identity.js — 节点身份、日志信封签名、写入请求授权。
//
// 这一层只解决一个问题：一段日志/一次写入，能不能证明是「哪个节点」发的，
// 并且没有被重放过。它不判断日志内容对不对（那是 sync.js），也不决定谁是权威
// （那是 server.js 的 term 解析）。
//
// 设计约束：
//   - 私钥只在本机文件里，不进世界存档、不进事件日志、不参与同步；
//   - 算法只用 node:crypto 自带的 Ed25519，零依赖；
//   - 首次接触靠 TOFU（trust on first use）固定公钥；之后的密钥变更一律拒绝，
//     需要人工删除 trust 文件。TOFU 不防首次 MITM，公网部署仍需 TLS。
//
// 三样东西：
//   1. 节点身份（Ed25519 密钥对 + keyId）
//   2. 日志信封签名（事件日志的完整性 + 来源）
//   3. 写入请求签名 + nonce 防重放（/api/journal/apply、/api/sync/adopt）

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stableStringify } from './sync.js';

export const IDENTITY_ALG = 'ed25519';
export const IDENTITY_VERSION = 'island-node-identity/1';
export const ENVELOPE_PURPOSE = 'island-journal-envelope/1';
export const REQUEST_PURPOSE = 'island-node-request/1';

// ---------- 基础 ----------

export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function normalizePublicKey(pem) {
  return String(pem || '').trim().replace(/\r\n/g, '\n');
}

// 公钥指纹：短、稳定、可读，用来在 UI 和日志里认节点。
export function keyIdFromPublicKey(publicKeyPem) {
  return `sha256:${sha256Hex(normalizePublicKey(publicKeyPem)).slice(0, 32)}`;
}

function signText(identity, text) {
  const key = createPrivateKey(identity.privateKey);
  return sign(null, Buffer.from(text, 'utf8'), key).toString('base64');
}

export function verifyText(publicKeyPem, text, signature) {
  try {
    if (!publicKeyPem || typeof signature !== 'string' || !signature) return false;
    const key = createPublicKey(normalizePublicKey(publicKeyPem));
    return verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

// 通用：签一个可规范化（stableStringify）的对象，不绑定具体用途。
export function signPayload(identity, payload) {
  return signText(identity, stableStringify(payload));
}

export function verifyPayload(publicKeyPem, payload, signature) {
  return verifyText(publicKeyPem, stableStringify(payload), signature);
}

// ---------- 节点身份 ----------

export function generateNodeIdentity(nodeId) {
  const { publicKey, privateKey } = generateKeyPairSync(IDENTITY_ALG);
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return {
    version: IDENTITY_VERSION,
    nodeId: String(nodeId),
    alg: IDENTITY_ALG,
    keyId: keyIdFromPublicKey(pub),
    publicKey: pub,
    privateKey: priv,
    createdAt: new Date().toISOString(),
  };
}

function writeSecretFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 基本无效；文件仍只在本机磁盘上。
  }
}

/**
 * 读取或创建本机节点身份。file 为空时只生成、不落盘（测试用）。
 * 身份文件的 nodeId 必须和当前配置一致；换了 NODE_ID 却复用旧文件会直接报错，
 * 否则同一把私钥会以两个名字出现在信任表里。
 */
export function loadOrCreateIdentity({ file = '', nodeId }) {
  if (file && fs.existsSync(file)) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (doc.version !== IDENTITY_VERSION) throw new Error(`unsupported identity version: ${doc.version}`);
    if (doc.alg !== IDENTITY_ALG) throw new Error(`unsupported identity algorithm: ${doc.alg}`);
    if (!doc.publicKey || !doc.privateKey) throw new Error('identity file is incomplete');
    if (String(doc.nodeId) !== String(nodeId)) {
      throw new Error(
        `identity file belongs to ${doc.nodeId}, but NODE_ID is ${nodeId}; ` +
          'delete the identity file or restore the old NODE_ID'
      );
    }
    doc.keyId = keyIdFromPublicKey(doc.publicKey);
    return doc;
  }

  const identity = generateNodeIdentity(nodeId);
  if (file) writeSecretFile(file, `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
}

export function publicIdentity(identity) {
  return {
    nodeId: identity.nodeId,
    alg: identity.alg,
    keyId: identity.keyId,
    publicKey: identity.publicKey,
  };
}

// ---------- 身份自证 ----------

// 身份响应里只签这些字段：节点名、公钥、种子、覆盖到的事件数与两个哈希。
// 角色、任期、租约倒计时是易变的观测值，不签。
function identityProofFields(doc) {
  return {
    nodeId: doc.nodeId,
    keyId: doc.keyId,
    publicKey: normalizePublicKey(doc.publicKey),
    seed: doc.seed,
    tick: doc.tick,
    events: doc.events,
    journalHash: doc.journalHash,
    stateHash: doc.stateHash,
    term: doc.term ?? null,
  };
}

/**
 * 把一把私钥的所有权绑定到一份身份声明上。对端收到 /api/identity 时，
 * 先验这个 proof，再按 nodeId 固定公钥；此后所有信封和请求都必须用这把钥匙。
 */
export function signIdentityDocument(identity, doc) {
  const withKey = {
    ...doc,
    alg: IDENTITY_ALG,
    keyId: identity.keyId,
    publicKey: normalizePublicKey(identity.publicKey),
  };
  const text = stableStringify({ purpose: IDENTITY_VERSION, ...identityProofFields(withKey) });
  return { ...withKey, proof: signText(identity, text) };
}

export function verifyIdentityDocument(doc) {
  if (!doc || typeof doc !== 'object') return false;
  if (doc.alg !== IDENTITY_ALG) return false;
  if (!doc.publicKey || typeof doc.proof !== 'string' || !doc.proof) return false;
  if (keyIdFromPublicKey(doc.publicKey) !== doc.keyId) return false;
  const text = stableStringify({ purpose: IDENTITY_VERSION, ...identityProofFields(doc) });
  return verifyText(doc.publicKey, text, doc.proof);
}

// ---------- 日志信封签名 ----------

// 只签会影响“这是哪一段日志”的字段。nodeId 是请求方的标签，可能被改写，不签。
export function envelopeSigningText(envelope) {
  return stableStringify({
    purpose: ENVELOPE_PURPOSE,
    protocol: envelope.protocol,
    seed: envelope.seed,
    epoch: envelope.epoch ?? 1,
    fromSeq: envelope.fromSeq,
    toSeq: envelope.toSeq,
    fromTick: envelope.fromTick,
    toTick: envelope.toTick,
    prevHash: envelope.prevHash ?? null,
    eventsHash: envelope.eventsHash,
    decisionsHash: envelope.decisionsHash,
    stateHash: envelope.stateHash,
  });
}

export function signEnvelope(envelope, identity) {
  return {
    ...envelope,
    signature: {
      alg: IDENTITY_ALG,
      nodeId: identity.nodeId,
      keyId: identity.keyId,
      value: signText(identity, envelopeSigningText(envelope)),
    },
  };
}

/**
 * 用一把已知公钥验证信封。nodeId 传了就要求签名者正好是它，
 * 防止把一个合法节点的签名挪到另一段自称来自别人的日志上。
 * 信封里的 eventsHash 本身已由 verifyJournal 校验，这里补的是“来源”和“未被替换”。
 */
export function verifyEnvelopeSignature(envelope, publicKeyPem, { nodeId = null } = {}) {
  const sig = envelope?.signature;
  if (!sig || sig.alg !== IDENTITY_ALG || typeof sig.value !== 'string') return false;
  if (nodeId !== null && sig.nodeId !== nodeId) return false;
  if (keyIdFromPublicKey(publicKeyPem) !== sig.keyId) return false;
  return verifyText(publicKeyPem, envelopeSigningText(envelope), sig.value);
}

// ---------- 写入请求签名 ----------

export function bodyDigest(body) {
  return sha256Hex(stableStringify(body ?? {}));
}

export function requestSigningText({ method, path: requestPath, nodeId, timestamp, nonce, body }) {
  return [
    REQUEST_PURPOSE,
    String(method || 'POST').toUpperCase(),
    String(requestPath || ''),
    String(nodeId || ''),
    String(timestamp),
    String(nonce || ''),
    bodyDigest(body),
  ].join('\n');
}

/**
 * 给一次 HTTP 写入请求签名。路径只签 pathname（不含 query），
 * 两端都按同一规则规范化，避免代理改 query 顺序导致签名失效。
 */
export function signRequest(identity, { method = 'POST', path: requestPath, body = {}, timestamp = Date.now(), nonce }) {
  const n = nonce || randomBytes(16).toString('hex');
  const text = requestSigningText({
    method,
    path: requestPath,
    nodeId: identity.nodeId,
    timestamp,
    nonce: n,
    body,
  });
  return {
    'x-node-id': identity.nodeId,
    'x-node-alg': IDENTITY_ALG,
    'x-node-key-id': identity.keyId,
    'x-node-timestamp': String(timestamp),
    'x-node-nonce': n,
    'x-node-signature': signText(identity, text),
    // 首次接触时随请求带上公钥；信任表固定之后这一项会被忽略。
    'x-node-public-key': Buffer.from(normalizePublicKey(identity.publicKey), 'utf8').toString('base64'),
  };
}

export function decodePublicKeyHeader(value) {
  try {
    const pem = Buffer.from(String(value || ''), 'base64').toString('utf8').trim();
    if (!pem.includes('BEGIN PUBLIC KEY')) return '';
    return normalizePublicKey(pem);
  } catch {
    return '';
  }
}

/**
 * 重放保护：先 inspect（只看不记），签名通过后再 remember。
 * 顺序很重要：如果先记 nonce 再验签，攻击者可以用伪造请求把受害节点的 nonce 占掉。
 */
export class ReplayGuard {
  constructor({ windowMs = 60_000, ttlMs = 300_000, now = () => Date.now() } = {}) {
    this.windowMs = Math.max(1000, Number(windowMs) || 60_000);
    this.ttlMs = Math.max(this.windowMs, Number(ttlMs) || 300_000);
    this.now = now;
    this.seen = new Map(); // `${nodeId}:${nonce}` -> expiresAt
  }

  sweep(now = this.now()) {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
  }

  inspect({ nodeId, timestamp, nonce, now = this.now() }) {
    if (!nodeId) return { ok: false, reason: 'missing node id' };
    if (!Number.isFinite(timestamp)) return { ok: false, reason: 'missing timestamp' };
    if (Math.abs(now - timestamp) > this.windowMs) return { ok: false, reason: 'clock skew too large' };
    if (!nonce || typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 128) {
      return { ok: false, reason: 'bad nonce' };
    }
    this.sweep(now);
    if (this.seen.has(`${nodeId}:${nonce}`)) return { ok: false, reason: 'replayed request' };
    return { ok: true };
  }

  remember({ nodeId, nonce, now = this.now() }) {
    this.sweep(now);
    const key = `${nodeId}:${nonce}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, now + this.ttlMs);
    return true;
  }
}

// ---------- 信任表（TOFU） ----------

/**
 * 本机记录“每个节点 id 对应哪把公钥”。第一次见到就固定，之后任何变化都拒绝。
 * 文件只在本机，不参与同步。要重新信任一个节点，只能人工删掉对应条目/整个文件。
 */
export class TrustStore {
  constructor({ file = '', now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.pins = new Map();
    this.dirty = false;
    this.lastSaveAt = 0;
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [nodeId, entry] of Object.entries(data.pins || {})) {
        if (entry?.publicKey) {
          this.pins.set(nodeId, {
            publicKey: normalizePublicKey(entry.publicKey),
            keyId: entry.keyId || keyIdFromPublicKey(entry.publicKey),
            firstSeenAt: entry.firstSeenAt || 0,
            lastSeenAt: entry.lastSeenAt || 0,
          });
        }
      }
    } catch (err) {
      console.error(`  信任表读取失败，按空表处理：${err.message}`);
    }
  }

  get(nodeId) {
    return this.pins.get(nodeId) || null;
  }

  size() {
    return this.pins.size;
  }

  trust(nodeId, publicKeyPem, { now = this.now(), persist = true } = {}) {
    const pem = normalizePublicKey(publicKeyPem);
    if (!nodeId || !pem) return { ok: false, status: 'invalid', reason: 'missing node id or public key' };
    const keyId = keyIdFromPublicKey(pem);
    const existing = this.pins.get(nodeId);
    if (!existing) {
      this.pins.set(nodeId, { publicKey: pem, keyId, firstSeenAt: now, lastSeenAt: now });
      this.dirty = true;
      if (persist) this.save();
      return { ok: true, status: 'new', keyId };
    }
    if (existing.publicKey !== pem) {
      return {
        ok: false,
        status: 'mismatch',
        reason: `node key mismatch for ${nodeId}`,
        pinnedKeyId: existing.keyId,
        presentedKeyId: keyId,
      };
    }
    existing.lastSeenAt = now;
    this.dirty = true;
    // 节流落盘：身份接口每个同步周期都会被拉一次。
    if (persist && (now - this.lastSaveAt > 5000 || !this.lastSaveAt)) this.save();
    return { ok: true, status: 'known', keyId };
  }

  reset(nodeId) {
    const existed = this.pins.delete(nodeId);
    if (existed) this.save();
    return existed;
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const data = { version: 'island-trust/1', pins: Object.fromEntries(this.pins) };
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      this.lastSaveAt = this.now();
    } catch (err) {
      console.error(`  信任表写入失败：${err.message}`);
    }
  }
}
