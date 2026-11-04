// server.js — 零依赖本地守护进程 + 网页看板。
// B 阶段主路径：全节点（SYNC_MODE=peer）双向拉日志、按事件数轮换权威；
// 权威失联时由轮值里的下一个节点按租约到期接任。单主 → 镜像只作演示/回归。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createWorld,
  snapshot,
  serializeWorld,
  loadWorld,
  deliverLetter,
  letterCooldownLeft,
  logTermEvent,
  setPresence,
  MS_PER_TICK,
} from './engine.js';
import { advanceOffline, stepWorld } from './persistence.js';
import { narrate, defaultNarrator, daySummaries } from './chronicle.js';
import { requestLLM } from './brain.js';
import {
  exportJournal,
  verifyJournal,
  applyChunk,
  rebuildFromJournal,
  eventsHash,
  stateHash,
  resolveTerm,
} from './sync.js';
import {
  ReplayGuard,
  TrustStore,
  decodePublicKeyHeader,
  keyIdFromPublicKey,
  loadOrCreateIdentity,
  normalizePublicKey,
  requestSigningText,
  signEnvelope,
  signIdentityDocument,
  signRequest,
  verifyEnvelopeSignature,
  verifyIdentityDocument,
  verifyText,
} from './identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4173);
const SAVE = process.env.SAVE_FILE
  ? path.resolve(process.env.SAVE_FILE)
  : path.join(__dirname, 'world-save.json');
const SEED = Number(process.env.SEED) || 20261102;
const NODE_ID = String(process.env.NODE_ID || `node-${PORT}`).slice(0, 32);
const MIRROR = process.env.MIRROR === '1';
const SYNC_MODE = MIRROR ? 'mirror' : String(process.env.SYNC_MODE || 'standalone');
const PEER = SYNC_MODE === 'peer';
const SYNC_TOKEN = String(process.env.SYNC_TOKEN || '');
const PEER_URL = String(process.env.PEER_URL || '').replace(/\/+$/, '');
const PEERS = String(process.env.PEERS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const NODE_NAMES = String(process.env.NODES || NODE_ID)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (!NODE_NAMES.includes(NODE_ID)) NODE_NAMES.push(NODE_ID);
const NODES = [...new Set(NODE_NAMES)].sort();
const TERM_EVENTS = Math.max(10, Number(process.env.TERM_EVENTS) || 200);
const HANDOFF_SETTLE_MS = Math.max(0, Number(process.env.HANDOFF_SETTLE_MS) || 500);
const SYNC_INTERVAL_MS = Math.max(100, Number(process.env.SYNC_INTERVAL_MS) || 2000);
const SAVE_INTERVAL_MS = Math.max(500, Number(process.env.SAVE_INTERVAL_MS) || 10_000);
const SPEED = Math.max(1, Math.min(8, Number(process.env.SPEED) || 1));
// 租约：权威失联多久算“过期”，交给轮值里的下一个节点。
// 下一任等待 1×TAKEOVER_MS，再下一个 2×，给更近的节点先接手的窗口。
const LEASE_MS = Math.max(200, Number(process.env.LEASE_MS) || 6000);
const TAKEOVER_MS = Math.max(
  LEASE_MS * 2,
  Number(process.env.TAKEOVER_MS) || LEASE_MS * 2
);

// 节点身份：私钥与信任表都只在本机，绝不进存档和事件日志。
const VERIFY_SIGNATURES = process.env.VERIFY_SIGNATURES !== '0';
const NODE_KEY_FILE = process.env.NODE_KEY_FILE
  ? path.resolve(process.env.NODE_KEY_FILE)
  : path.join(__dirname, `node-key-${NODE_ID.replace(/[^\w.-]/g, '_')}.json`);
const TRUST_FILE = process.env.TRUST_FILE
  ? path.resolve(process.env.TRUST_FILE)
  : path.join(__dirname, `trusted-peers-${NODE_ID.replace(/[^\w.-]/g, '_')}.json`);
const NODE_CLOCK_SKEW_MS = Math.max(5000, Number(process.env.NODE_CLOCK_SKEW_MS) || 60_000);
const REPLAY_TTL_MS = Math.max(NODE_CLOCK_SKEW_MS, Number(process.env.REPLAY_TTL_MS) || 300_000);

// 在线租约：观看者心跳的有效期（现实时间）与写进日志的清醒租约（世界 tick）。
// 1 tick = 1 世界分钟；默认租约 300 tick ≈ 现实 12.5 秒。
const TENDER_TTL_MS = Math.max(1000, Number(process.env.TENDER_TTL_MS) || 15_000);
const PRESENCE_LEASE_TICKS = Math.max(10, Number(process.env.PRESENCE_LEASE_TICKS) || 300);

// 可选 TLS：同时给出证书和私钥就换成 https，对端 URL 也要写 https://。
const TLS_KEY_FILE = process.env.TLS_KEY_FILE ? path.resolve(process.env.TLS_KEY_FILE) : '';
const TLS_CERT_FILE = process.env.TLS_CERT_FILE ? path.resolve(process.env.TLS_CERT_FILE) : '';
const SECURE = !!(TLS_KEY_FILE && TLS_CERT_FILE);

let identity;
try {
  identity = loadOrCreateIdentity({ file: NODE_KEY_FILE, nodeId: NODE_ID });
} catch (err) {
  console.error(`  节点身份加载失败：${err.message}`);
  process.exit(1);
}
const trust = new TrustStore({ file: TRUST_FILE });
const replayGuard = new ReplayGuard({ windowMs: NODE_CLOCK_SKEW_MS, ttlMs: REPLAY_TTL_MS });
// URL -> 对端自报的 nodeId。同一个地址换了身份必须停下来，不能悄悄改写信任关系。
const peerNodeIds = new Map();

function loadOrCreate() {
  if (!fs.existsSync(SAVE)) return createWorld(SEED);
  try {
    const data = JSON.parse(fs.readFileSync(SAVE, 'utf8'));
    const loaded = loadWorld(data.world);
    const elapsed = Math.max(0, Date.now() - (Number(data.savedAt) || Date.now()));
    if (MIRROR || PEER) {
      loaded.returnSummary = null;
      console.log(`  从存档恢复：第 ${loaded.day} 天 · 等待同步`);
    } else {
      loaded.returnSummary = advanceOffline(loaded, elapsed);
      console.log(`  从存档恢复：第 ${loaded.day} 天 · 离线推进 ${loaded.returnSummary.ticks} tick`);
    }
    return loaded;
  } catch (err) {
    console.error(`  存档读取失败，重新开始：${err.message}`);
    return createWorld(SEED);
  }
}

let world = loadOrCreate();
world.config.speed = SPEED;
const clients = new Set();

let lastSyncAt = 0;
let lastSyncError = '';
let lastSyncedTick = -1;
let syncing = false;
let syncFault = '';
let handoffReady = false;
let handoffStart = 0;
let lastAuthorityId = null;
let lastTakeoverAt = 0;
let sawSelfAuthority = false;
// 上次因更高任期重建世界时丢掉了多少条本地未同步事件。
// 分区愈合后这里会非零；普通故障恢复（旧权威崩溃）也可能非零。
let lastAdoption = null;

const startupAt = Date.now();
// 每个已知节点的最后一次真实接触（拉身份成功，或对方来写日志）。
// 墙钟只用来判断“失联多久”，不参与排序；排序只看日志里的 term / seq。
const nodeLastSeen = new Map(NODES.map((id) => [id, startupAt]));
const peerHealth = new Map(); // url -> { nodeId, lastSeenAt, term, events, error }
// viewerId -> { agentId, at }。这是本机观看者的守望，不跨节点同步；
// 只有当前权威会把它翻译成日志里的 presence 事件。
const tenders = new Map();

// 轮值日志权威：term 优先取日志里最后一次交接记录，其次由事件数轮换。
// 所有节点从同一条日志算出同一个排序。
function termState() {
  return resolveTerm(world.eventLog, { nodes: NODES, termEvents: TERM_EVENTS });
}

function currentTerm() {
  return termState().term;
}

function authorityFor() {
  if (!PEER) return NODE_ID;
  return termState().authorityId;
}

function isAuthority() {
  return !PEER || authorityFor() === NODE_ID;
}

// 从当前权威往后数，本节点排第几个。越靠前越早接手。
function takeoverOffset(authorityId, nodeId = NODE_ID) {
  const from = NODES.indexOf(authorityId);
  const to = NODES.indexOf(nodeId);
  if (from < 0 || to < 0 || NODES.length === 0) return NODES.length || 1;
  return ((to - from) + NODES.length) % NODES.length || 1;
}

function noteNodeSeen(nodeId, at = Date.now()) {
  if (nodeId) nodeLastSeen.set(nodeId, at);
}

function canWriteLocally() {
  if (MIRROR) return false;
  if (!PEER) return true;
  return isAuthority() && handoffReady && !syncFault;
}

function canAdvance() {
  if (MIRROR) return false;
  if (world.config.paused) return false;
  if (!PEER) return true;
  return !syncFault && isAuthority() && handoffReady;
}

// 观看者的守望心跳：谁被看着，谁就醒着。只有当前权威能把它写进日志。
// 返回本次实际写了几条 presence 事件（续期也算）。
function activeTenders(now = Date.now()) {
  const active = new Map(); // agentId -> viewerId
  for (const [viewerId, tender] of tenders) {
    if (now - tender.at > TENDER_TTL_MS) {
      tenders.delete(viewerId);
      continue;
    }
    const agent = world.agents.find((a) => a.id === tender.agentId && a.alive && !a.faded);
    if (!agent) {
      tenders.delete(viewerId);
      continue;
    }
    if (!active.has(agent.id)) active.set(agent.id, viewerId);
  }
  return active;
}

function reconcilePresence(now = Date.now()) {
  if (!canWriteLocally()) return 0;
  const active = activeTenders(now);
  const renewBelow = Math.floor(PRESENCE_LEASE_TICKS / 2);
  let written = 0;
  for (const agent of world.agents) {
    if (!agent.alive || agent.faded) continue;
    if (active.has(agent.id)) {
      const remaining = (agent.presenceUntil || 0) - world.tick;
      if (agent.presence !== 'online' || remaining <= renewBelow) {
        const event = setPresence(world, agent, {
          online: true,
          untilTick: world.tick + PRESENCE_LEASE_TICKS,
          by: active.get(agent.id),
          reason: 'tend',
        });
        if (event) written++;
      }
    } else if (agent.presence === 'online') {
      const event = setPresence(world, agent, { online: false, reason: 'no-tender' });
      if (event) written++;
    }
  }
  return written;
}

function applyApiConfig(source) {
  world.api.provider = source.provider === 'anthropic' ? 'anthropic' : 'openai';
  world.api.base = String(source.base || '').trim();
  world.api.key = String(source.key || '').trim();
  world.api.model = String(source.model || '').trim();
  const raw = source.llmAgents === undefined ? world.agents.length : Number(source.llmAgents);
  const count = Math.max(0, Math.min(world.agents.length, Number.isFinite(raw) ? raw : world.agents.length));
  world.config.llmAgents = count;
  world.agents.forEach((a, i) => {
    a.useLLM = !!world.api.key && i < count;
  });
}

if (process.env.LLM_BASE) {
  applyApiConfig({
    provider: process.env.LLM_PROVIDER,
    base: process.env.LLM_BASE,
    key: process.env.LLM_KEY,
    model: process.env.LLM_MODEL,
    llmAgents: process.env.LLM_AGENTS,
  });
  console.log(`  LLM: ${world.api.provider} · ${world.api.model} · ${world.config.llmAgents} 人`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function tokenOk(req) {
  if (!SYNC_TOKEN) return false;
  const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(SYNC_TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * 写入请求的授权：bearer token 或节点签名，二者其一。
 * 签名请求带 timestamp + nonce，先 inspect 再验签再 remember，防止用伪造请求占 nonce。
 * 返回 publicKey，供后续验证信封签名（写日志的节点必须和签请求的是同一个）。
 */
function authPeerRequest(req, body) {
  if (tokenOk(req)) {
    // 镜像/单主模式仍用 token 授权，但请求会带节点的自报公钥；
    // 用它把写入者的钥匙固定下来，后续才能校验它发来的签名日志。
    const claimedId = String(req.headers['x-node-id'] || '').slice(0, 64);
    const presented = decodePublicKeyHeader(req.headers['x-node-public-key']);
    const claimedKeyId = String(req.headers['x-node-key-id'] || '');
    if (claimedId && presented && keyIdFromPublicKey(presented) === claimedKeyId) {
      const pin = trust.trust(claimedId, presented);
      if (pin.ok) return { ok: true, via: 'token', nodeId: claimedId, publicKey: presented };
    }
    return { ok: true, via: 'token', nodeId: null, publicKey: null };
  }
  if (!VERIFY_SIGNATURES) return { ok: false, status: 401, error: 'unauthorized' };

  const nodeId = String(req.headers['x-node-id'] || '').slice(0, 64);
  const timestamp = Number(req.headers['x-node-timestamp']);
  const nonce = String(req.headers['x-node-nonce'] || '');
  const signature = String(req.headers['x-node-signature'] || '');
  if (!nodeId || !nonce || !signature || !Number.isFinite(timestamp)) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }

  const inspected = replayGuard.inspect({ nodeId, timestamp, nonce });
  if (!inspected.ok) return { ok: false, status: 401, error: inspected.reason };

  const pinned = trust.get(nodeId);
  let publicKey = pinned ? pinned.publicKey : '';
  if (!publicKey) {
    // 首次接触：只接受随请求自带的公钥，先把“这把钥匙确实签了这次请求”验过再固定。
    const presented = decodePublicKeyHeader(req.headers['x-node-public-key']);
    const claimedKeyId = String(req.headers['x-node-key-id'] || '');
    if (!presented || keyIdFromPublicKey(presented) !== claimedKeyId) {
      return { ok: false, status: 401, error: 'unknown node key' };
    }
    publicKey = presented;
  }

  const requestPath = new URL(req.url, 'http://localhost').pathname;
  const text = requestSigningText({
    method: req.method,
    path: requestPath,
    nodeId,
    timestamp,
    nonce,
    body,
  });
  if (!verifyText(publicKey, text, signature)) {
    return { ok: false, status: 401, error: 'bad request signature' };
  }
  if (!replayGuard.remember({ nodeId, nonce })) {
    return { ok: false, status: 401, error: 'replayed request' };
  }

  const pin = trust.trust(nodeId, publicKey);
  if (!pin.ok) {
    console.error(`  ${pin.reason}（已固定 ${pin.pinnedKeyId}，对方出示 ${pin.presentedKeyId}）`);
    return { ok: false, status: 409, error: pin.reason };
  }
  return { ok: true, via: 'signature', nodeId, publicKey };
}

/**
 * 请求体里的日志信封如果是签名的，必须由已授权节点签；
 * peer 模式下强制要求信封签名，token 只用于过渡期的人工导入。
 */
function checkEnvelopeSignature(envelope, auth) {
  if (!VERIFY_SIGNATURES) return { ok: true };
  const sig = envelope?.signature;
  if (!sig) {
    // peer 模式不接受无签名日志；token 只留给镜像/过渡期的人工导入。
    if (PEER || auth.via === 'signature') {
      return { ok: false, status: 400, error: 'journal signature required' };
    }
    return { ok: true };
  }
  const signerId = String(sig.nodeId || '');
  if (!signerId) return { ok: false, status: 400, error: 'journal signature has no node id' };
  if (auth.nodeId && signerId !== auth.nodeId) {
    return { ok: false, status: 403, error: 'journal signed by a different node' };
  }
  const pinned = signerId === auth.nodeId ? auth.publicKey : trust.get(signerId)?.publicKey;
  if (!pinned) return { ok: false, status: 401, error: `unknown journal signer ${signerId}` };
  if (!verifyEnvelopeSignature(envelope, pinned, { nodeId: signerId })) {
    return { ok: false, status: 400, error: 'journal signature invalid' };
  }
  return { ok: true };
}

/**
 * 拉一个对端的身份声明：验自证签名 → 按 nodeId 固定公钥 → 检查地址没换人。
 * 返回的 publicKey 就是之后验证它日志信封的唯一依据。
 */
async function fetchPeerIdentity(peer) {
  const response = await fetch(`${peer}/api/identity`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`peer identity HTTP ${response.status}`);
  const doc = await response.json();
  if (!doc || typeof doc.nodeId !== 'string' || !doc.nodeId) throw new Error('peer identity has no node id');

  const known = peerNodeIds.get(peer);
  if (known && known !== doc.nodeId) {
    throw new Error(`conflict: ${peer} changed identity from ${known} to ${doc.nodeId}`);
  }
  peerNodeIds.set(peer, doc.nodeId);

  if (!VERIFY_SIGNATURES) return { ...doc, publicKey: doc.publicKey ? normalizePublicKey(doc.publicKey) : null };
  if (!doc.publicKey || !doc.proof) throw new Error('conflict: peer identity is unsigned');
  if (!verifyIdentityDocument(doc)) throw new Error('conflict: peer identity proof invalid');

  const pin = trust.trust(doc.nodeId, doc.publicKey);
  if (!pin.ok) throw new Error(`conflict: ${pin.reason}`);
  return { ...doc, publicKey: normalizePublicKey(doc.publicKey) };
}

function verifyPeerEnvelope(envelope, peerIdentity) {
  if (!VERIFY_SIGNATURES) return { ok: true };
  if (!peerIdentity?.publicKey) return { ok: false, reason: 'no pinned key for peer' };
  if (!verifyEnvelopeSignature(envelope, peerIdentity.publicKey, { nodeId: peerIdentity.nodeId })) {
    return { ok: false, reason: 'journal signature invalid' };
  }
  return { ok: true };
}

// 观看者自己的模型写这段编年史。事实由引擎给，模型只负责叙述。
async function llmNarrator(context) {
  const lines = context.facts.map((f) => {
    const who = f.people.map((p) => p.name).filter(Boolean).join('、');
    const where = f.place ? `，地点：${f.place}` : '';
    return `[${f.day}日 ${f.clock}] ${f.text}${who ? `（涉及：${who}${where}）` : where}`;
  });
  const sys =
    '你是一位观看者，正在读一座岛上的编年史。只根据给出的事实写一段简洁的中文叙事，' +
    '不要编造事实之外的事，不要写分析、结论或标题。第三人称，克制，有画面感。不超过 400 字。';
  const viewerLine =
    context.viewer.kind === 'resident'
      ? `观看者：${context.viewer.name}（岛上的居民，身份：${context.viewer.identity || '还没有脱变'}）`
      : `观看者：${context.viewer.name}`;
  const user = `${viewerLine}
时间范围：第 ${context.range.fromDay} 天到第 ${context.range.toDay} 天
事实：
${lines.join('\n') || '（这段时间没有关键事件）'}

请写一段叙事。`;

  world.llmCalls = (world.llmCalls || 0) + 1;
  const text = await requestLLM(world, sys, user, 700);
  if (!String(text || '').trim()) throw new Error('LLM 返回了空叙事');
  return text;
}

async function handleApi(req, res, url) {
  const body = await readBody(req);

  if (url.pathname === '/api/pause') {
    if (!canWriteLocally()) return json(res, { ok: false, error: 'this node is read-only right now' }, 403);
    world.config.paused = !!body.paused;
    return json(res, { ok: true, paused: world.config.paused });
  }

  if (url.pathname === '/api/speed') {
    if (!canWriteLocally()) return json(res, { ok: false, error: 'this node is read-only right now' }, 403);
    const s = Math.max(1, Math.min(8, Number(body.speed) || 1));
    world.config.speed = s;
    return json(res, { ok: true, speed: s });
  }

  if (url.pathname === '/api/whisper') {
    if (!canWriteLocally()) return json(res, { ok: false, error: 'this node is read-only right now' }, 403);
    const a = world.agents.find((x) => x.id === body.agentId);
    if (!a) return json(res, { ok: false, error: 'no such agent' }, 404);
    const cooldown = letterCooldownLeft(world, a);
    if (cooldown > 0) {
      return json(res, { ok: false, error: 'cooldown', cooldownLeft: cooldown }, 429);
    }
    const text = String(body.text || '').slice(0, 160).trim();
    if (!text) return json(res, { ok: false, error: 'empty' }, 400);
    const heard = deliverLetter(world, a, text);
    return json(res, { ok: true, heard, cooldownLeft: letterCooldownLeft(world, a) });
  }

  // 观看者的守望心跳。agentId 为空表示“我不再看任何人了”。
  // 这里不写日志；只有当前权威的下一个 reconcilePresence 才把它翻译成 presence 事件。
  if (url.pathname === '/api/presence') {
    const viewerId = String(body.viewerId || '').slice(0, 64);
    if (!viewerId) return json(res, { ok: false, error: 'viewerId is required' }, 400);
    if (MIRROR) return json(res, { ok: false, error: 'this node is read-only' }, 403);

    const agentId = body.agentId ? String(body.agentId).slice(0, 32) : '';
    let agent = null;
    if (agentId) {
      agent = world.agents.find((a) => a.id === agentId && a.alive && !a.faded);
      if (!agent) return json(res, { ok: false, error: 'no such resident' }, 404);
      tenders.set(viewerId, { agentId, at: Date.now() });
    } else {
      tenders.delete(viewerId);
    }

    const wrote = reconcilePresence();
    if (!canWriteLocally()) {
      return json(
        res,
        {
          ok: false,
          error: 'this node is not the log authority',
          authorityId: authorityFor(),
          presence: agent ? agent.presence : null,
        },
        409
      );
    }
    return json(res, {
      ok: true,
      agentId: agentId || null,
      presence: agent ? agent.presence : null,
      presenceUntil: agent ? agent.presenceUntil || 0 : 0,
      leaseTicks: PRESENCE_LEASE_TICKS,
      tenders: tenders.size,
      wrote,
    });
  }

  if (url.pathname === '/api/timeline') {
    return json(res, { currentDay: world.day || 1, days: daySummaries(world) });
  }

  // B 阶段地基：导出可交换的日志信封，用本节点私钥签名。
  if (url.pathname === '/api/journal') {
    const fromSeq = Math.max(1, Math.floor(Number(url.searchParams.get('fromSeq')) || 1));
    const nodeId = String(url.searchParams.get('nodeId') || NODE_ID).slice(0, 32);
    const epoch = Math.max(1, Math.floor(Number(url.searchParams.get('epoch')) || 1));
    const envelope = exportJournal(world, { fromSeq, nodeId, epoch });
    return json(res, signEnvelope(envelope, identity));
  }

  // 身份与当前状态哈希：两台机器互相对账用。
  if (url.pathname === '/api/identity') {
    const now = Date.now();
    const state = termState();
    const selfAuthority = state.authorityId === NODE_ID;
    const authorityLastSeenAt = selfAuthority ? now : nodeLastSeen.get(state.authorityId) || 0;
    const silentFor = Math.max(0, now - authorityLastSeenAt);
    const offset = takeoverOffset(state.authorityId);
    // 身份声明由本节点私钥自证；对端验过之后会固定这把公钥。
    const doc = {
      nodeId: NODE_ID,
      seed: world.seed,
      tick: world.tick,
      day: world.day || 1,
      clock: world.clock || '08:00',
      events: world.nextSeq - 1,
      journalHash: exportJournal(world).eventsHash,
      stateHash: stateHash(world),
      mode: SYNC_MODE,
      mirror: MIRROR,
      peer: PEER_URL || null,
      peers: PEERS,
      role: PEER ? (isAuthority() ? 'authority' : 'follower') : MIRROR ? 'mirror' : 'standalone',
      term: PEER ? state.term : null,
      termSource: PEER ? state.source : null,
      termEvents: PEER ? TERM_EVENTS : null,
      nodes: PEER ? NODES : [],
      authorityId: PEER ? state.authorityId : null,
      successorId: PEER && NODES.length ? NODES[(NODES.indexOf(state.authorityId) + 1 + NODES.length) % NODES.length] : null,
      handoffReady: PEER ? handoffReady : null,
      canWrite: canWriteLocally(),
      deputized: PEER ? lastTakeoverAt > 0 : null,
      deposed: PEER ? sawSelfAuthority && !isAuthority() : null,
      leaseMs: PEER ? LEASE_MS : null,
      takeoverMs: PEER ? TAKEOVER_MS : null,
      leaseExpired: PEER && !selfAuthority ? silentFor >= LEASE_MS : false,
      authorityLastSeenAgoMs: PEER && !selfAuthority ? silentFor : 0,
      takeoverEtaMs: PEER && !selfAuthority ? Math.max(0, TAKEOVER_MS * offset - silentFor) : null,
      lastTakeoverAt: PEER && lastTakeoverAt ? lastTakeoverAt : null,
      lastAdoption: lastAdoption || null,
      trustedPeers: [...trust.pins.entries()].map(([nodeId, pin]) => ({
        nodeId,
        keyId: pin.keyId,
        firstSeenAt: pin.firstSeenAt,
        lastSeenAt: pin.lastSeenAt,
      })),
      syncFault: syncFault || null,
      lastSyncAt: lastSyncAt || null,
      lastSyncedTick,
      lastSyncError,
      peerHealth: PEER
        ? [...peerHealth.entries()].map(([url, health]) => ({
            url,
            nodeId: health.nodeId,
            lastSeenAgoMs: Math.max(0, now - health.lastSeenAt),
            term: health.term,
            events: health.events,
            error: health.error || '',
          }))
        : [],
    };
    return json(res, signIdentityDocument(identity, doc));
  }

  // 手动存档：两机演示和断线重连前先落一次盘。
  if (url.pathname === '/api/save') {
    saveWorld();
    return json(res, { ok: true, savedAt: Date.now(), tick: world.tick, stateHash: stateHash(world) });
  }

  // 接收日志块：镜像模式用于演示推送，peer 模式用于手动/测试导入。
  // 授权：bearer token 或带 nonce 的节点签名；握手期间两者都可以。
  if (url.pathname === '/api/journal/apply') {
    if (!MIRROR && !PEER) {
      return json(res, { ok: false, error: 'journal apply is disabled on standalone nodes' }, 403);
    }
    if (!SYNC_TOKEN && !VERIFY_SIGNATURES) {
      return json(res, { ok: false, error: 'SYNC_TOKEN is required for journal apply' }, 503);
    }
    const auth = authPeerRequest(req, body);
    if (!auth.ok) {
      return json(res, { ok: false, error: auth.error }, auth.status);
    }
    const envelopeCheck = checkEnvelopeSignature(body, auth);
    if (!envelopeCheck.ok) {
      if (PEER && envelopeCheck.status === 400) syncFault = envelopeCheck.error;
      return json(res, { ok: false, error: envelopeCheck.error }, envelopeCheck.status);
    }
    const writerId = auth.nodeId || (body.nodeId && body.nodeId !== NODE_ID ? body.nodeId : '');
    if (writerId) noteNodeSeen(writerId);
    const result = applyChunk(world, body);
    if (!result.ok) return json(res, { ok: false, ...result }, 400);
    if (!result.matched) {
      if (PEER) syncFault = 'state hash mismatch';
      return json(
        res,
        { ok: false, error: 'state hash mismatch', local: stateHash(result.world), claimed: body.stateHash },
        409
      );
    }
    world = result.world;
    lastSyncAt = Date.now();
    lastSyncedTick = world.tick;
    lastSyncError = '';
    if (PEER) {
      // 收到别人的日志后，先重新交接，再决定能不能写。
      handoffReady = false;
      handoffStart = 0;
    }
    return json(res, {
      ok: true,
      tick: world.tick,
      day: world.day || 1,
      events: world.nextSeq - 1,
      stateHash: stateHash(world),
    });
  }

  // 校验一份别人发来的日志，并说明它是否正好覆盖本地当前的头部。
  if (url.pathname === '/api/journal/verify') {
    const check = verifyJournal(body);
    if (!check.ok) return json(res, { ok: false, ...check }, 400);
    const seedMatch = body.seed === world.seed;
    const covers = body.fromSeq <= 1 && body.toTick === world.tick;
    const localStateHash = stateHash(world);
    return json(res, {
      ok: true,
      verified: true,
      seedMatch,
      coversLocalHead: covers,
      localStateHash,
      journalStateHash: body.stateHash,
      matched: seedMatch && covers ? localStateHash === body.stateHash : null,
    });
  }

  // 分叉的人工出口：由人明确指定一个对端的完整日志作为基准，重建本地世界。
  // 这是唯一会丢掉本地未同步尾巴的操作，所以只接受显式调用与 token。
  if (url.pathname === '/api/sync/adopt') {
    if (!PEER) return json(res, { ok: false, error: 'peer mode only' }, 403);
    if (!SYNC_TOKEN && !VERIFY_SIGNATURES) {
      return json(res, { ok: false, error: 'SYNC_TOKEN is required' }, 503);
    }
    const auth = authPeerRequest(req, body);
    if (!auth.ok) return json(res, { ok: false, error: auth.error }, auth.status);

    const peer = String(body.peer || '').trim().replace(/\/+$/, '');
    if (!peer) return json(res, { ok: false, error: 'peer is required' }, 400);
    try {
      // 先拿到对端身份并固定公钥，再拉日志；否则无法确认日志是谁签的。
      const peerIdentity = await fetchPeerIdentity(peer);
      const response = await fetch(`${peer}/api/journal`, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`peer journal HTTP ${response.status}`);
      const envelope = await response.json();
      const signatureCheck = verifyPeerEnvelope(envelope, peerIdentity);
      if (!signatureCheck.ok) throw new Error(`conflict: ${signatureCheck.reason}`);
      const check = verifyJournal(envelope);
      if (!check.ok) return json(res, { ok: false, error: check.reason }, 400);
      if (envelope.seed !== world.seed) return json(res, { ok: false, error: 'seed mismatch' }, 400);
      const remoteTerm = resolveTerm(envelope.events, { nodes: NODES, termEvents: TERM_EVENTS }).term;
      if (remoteTerm < currentTerm()) {
        return json(res, { ok: false, error: `peer term ${remoteTerm} is behind local term ${currentTerm()}` }, 409);
      }
      let rebuilt;
      try {
        rebuilt = rebuildFromJournal(envelope);
      } catch (err) {
        return json(res, { ok: false, error: String(err?.message || err) }, 400);
      }
      if (stateHash(rebuilt) !== envelope.stateHash) {
        return json(res, { ok: false, error: 'rebuilt state does not match peer hash' }, 409);
      }
      const dropped = Math.max(0, world.nextSeq - 1 - envelope.toSeq);
      world = rebuilt;
      syncFault = '';
      handoffReady = false;
      handoffStart = 0;
      lastSyncError = '';
      lastSyncAt = Date.now();
      lastSyncedTick = world.tick;
      lastAdoption = { at: Date.now(), from: peer, term: remoteTerm, dropped, via: 'manual' };
      return json(res, {
        ok: true,
        tick: world.tick,
        events: world.nextSeq - 1,
        stateHash: stateHash(world),
        term: currentTerm(),
        dropped,
      });
    } catch (err) {
      return json(res, { ok: false, error: String(err?.message || err) }, 502);
    }
  }

  if (url.pathname === '/api/chronicle') {
    const viewerId = String(body.viewerId || '').slice(0, 64) || null;
    const fromDay = Math.max(1, Math.floor(Number(body.fromDay) || 1));
    const toDay = Math.max(fromDay, Math.floor(Number(body.toDay) || fromDay));
    const range = { fromDay, toDay };

    if (!world.api.key) {
      const result = await narrate(world, viewerId, range, defaultNarrator);
      return json(res, { ok: true, ...result, model: false, fallback: false });
    }

    try {
      const result = await narrate(world, viewerId, range, llmNarrator);
      return json(res, { ok: true, ...result, model: true, fallback: false });
    } catch (err) {
      world.llmErrors = (world.llmErrors || 0) + 1;
      world.llmLastError = String(err?.message || err);
      const result = await narrate(world, viewerId, range, defaultNarrator, { cache: false });
      return json(res, { ok: true, ...result, model: true, fallback: true });
    }
  }

  if (url.pathname === '/api/config') {
    applyApiConfig(body);
    return json(res, { ok: true, configured: !!world.api.key, llmAgents: world.config.llmAgents });
  }

  if (url.pathname === '/api/state') {
    return json(res, snapshot(world));
  }

  return json(res, { ok: false }, 404);
}

const requestHandler = (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify(snapshot(world))}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => json(res, { ok: false, error: String(err) }, 500));
    return;
  }

  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC, decodeURIComponent(rel)));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
};

let server;
if (SECURE) {
  try {
    server = https.createServer(
      { key: fs.readFileSync(TLS_KEY_FILE), cert: fs.readFileSync(TLS_CERT_FILE) },
      requestHandler
    );
  } catch (err) {
    console.error(`  TLS 证书加载失败：${err.message}`);
    process.exit(1);
  }
} else {
  server = http.createServer(requestHandler);
}

function broadcast() {
  const msg = `data: ${JSON.stringify(snapshot(world))}\n\n`;
  for (const c of clients) {
    try {
      c.write(msg);
    } catch {
      clients.delete(c);
    }
  }
}

async function syncPeer() {
  if (PEER || MIRROR || !PEER_URL || (!SYNC_TOKEN && !VERIFY_SIGNATURES) || world.inflight > 0) return;

  try {
    const peerDoc = await fetchPeerIdentity(PEER_URL);
    if (peerDoc.seed !== world.seed) throw new Error('peer seed mismatch');

    const fromSeq = Math.max(1, Math.floor(Number(peerDoc.events) || 0) + 1);
    if (fromSeq > world.nextSeq) throw new Error('peer is ahead of leader');

    const prefix = world.eventLog.filter((e) => e.seq < fromSeq);
    const prefixHash = eventsHash(prefix);
    if (peerDoc.events > 0 && peerDoc.journalHash !== prefixHash) {
      throw new Error('peer journal diverged before current head');
    }

    const chunk = signEnvelope(
      exportJournal(world, {
        fromSeq,
        prevHash: fromSeq > 1 ? prefixHash : null,
        nodeId: NODE_ID,
      }),
      identity
    );
    if (!chunk.ready) return;

    const headers = {
      'Content-Type': 'application/json',
      ...signRequest(identity, { method: 'POST', path: '/api/journal/apply', body: chunk }),
    };
    if (SYNC_TOKEN) headers.Authorization = `Bearer ${SYNC_TOKEN}`;

    const response = await fetch(`${PEER_URL}/api/journal/apply`, {
      method: 'POST',
      headers,
      body: JSON.stringify(chunk),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error || `peer apply HTTP ${response.status}`);
    }

    lastSyncAt = Date.now();
    lastSyncedTick = result.tick;
    lastSyncError = '';
  } catch (err) {
    lastSyncError = String(err?.message || err);
  }
}

// 对端任期更高、但本地尾巴和它对不上时，以更高任期为准：
// 用对方的完整日志重建本地世界。日志只追加，但“未同步的旧任期尾巴”
// 没有被任何人接受，丢弃它是 B 阶段 v1 的确定规则（更高 term 优先）。
// 同任期内出现分叉仍然只报 syncFault，不在这里合并。
async function adoptPeerJournal(peer) {
  const localTerm = termState().term;
  const peerDoc = await fetchPeerIdentity(peer);
  const response = await fetch(`${peer}/api/journal`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`peer full journal HTTP ${response.status}`);
  const envelope = await response.json();
  const signatureCheck = verifyPeerEnvelope(envelope, peerDoc);
  if (!signatureCheck.ok) throw new Error(`conflict: ${signatureCheck.reason}`);
  const check = verifyJournal(envelope);
  if (!check.ok) throw new Error(`conflict: peer journal ${check.reason}`);
  if (envelope.seed !== world.seed) throw new Error('conflict: peer seed mismatch');

  const peerTerm = resolveTerm(envelope.events, { nodes: NODES, termEvents: TERM_EVENTS }).term;
  if (peerTerm <= localTerm) throw new Error('conflict: peer journal has no higher term');

  const dropped = Math.max(0, world.nextSeq - 1 - envelope.toSeq);
  let rebuilt;
  try {
    rebuilt = rebuildFromJournal(envelope);
  } catch (err) {
    throw new Error(`conflict: ${String(err?.message || err)}`);
  }
  if (stateHash(rebuilt) !== envelope.stateHash) {
    throw new Error('conflict: adopted state hash mismatch');
  }

  world = rebuilt;
  syncFault = '';
  lastSyncAt = Date.now();
  lastSyncedTick = world.tick;
  lastAdoption = { at: Date.now(), from: peer, term: peerTerm, dropped, via: 'auto' };
  console.log(`  以第 ${peerTerm} 任的日志为准重建，丢弃本地 ${dropped} 条未同步事件`);
  return { adopted: true, dropped };
}

// peer 模式：每个节点都从对端拉缺失日志。谁拉谁都不改变“日志是权威”这条。
async function pullFromPeer(peer) {
  // 身份先验自证、再固定公钥；后面这块日志的签名必须是同一把钥匙签的。
  const peerDoc = await fetchPeerIdentity(peer);
  // 拿到身份就算一次真实接触：租约只看这个，不看谁先发起。
  const seenAt = Date.now();
  noteNodeSeen(peerDoc.nodeId, seenAt);
  peerHealth.set(peer, {
    nodeId: peerDoc.nodeId,
    lastSeenAt: seenAt,
    term: peerDoc.term,
    events: peerDoc.events,
    error: '',
  });
  if (peerDoc.seed !== world.seed) throw new Error('conflict: peer seed mismatch');

  const localTerm = termState().term;
  const peerTerm = Number.isInteger(peerDoc.term) ? peerDoc.term : localTerm;

  const localHead = world.nextSeq - 1;
  if (peerDoc.events < localHead) {
    // 对端更短、任期却更高：本地尾巴是一段没人接受的旧任期事件。
    if (peerTerm > localTerm) return adoptPeerJournal(peer);
    return { behind: true };
  }

  if (peerDoc.events === localHead) {
    if (peerTerm > localTerm) return adoptPeerJournal(peer);
    // 头部相同却没有同一个状态，说明已经分叉，必须停下来。
    if (peerDoc.tick === world.tick && peerDoc.stateHash !== stateHash(world)) {
      throw new Error('conflict: same head but state hash differs');
    }
    return { noop: true };
  }

  const journalResponse = await fetch(
    `${peer}/api/journal?fromSeq=${world.nextSeq}&nodeId=${encodeURIComponent(NODE_ID)}`,
    { signal: AbortSignal.timeout(10_000) }
  );
  if (!journalResponse.ok) throw new Error(`peer journal HTTP ${journalResponse.status}`);
  const chunk = await journalResponse.json();
  if (!chunk.events?.length) return { noop: true };

  const signatureCheck = verifyPeerEnvelope(chunk, peerDoc);
  if (!signatureCheck.ok) throw new Error(`conflict: ${signatureCheck.reason}`);

  const result = applyChunk(world, chunk);
  if (!result.ok) {
    if (result.reason === 'stale chunk') return { stale: true };
    // 前缀对不上但对方任期更高：以更高任期为准确认并重建。
    if (peerTerm > localTerm) return adoptPeerJournal(peer);
    throw new Error(`conflict: ${result.reason}`);
  }
  if (!result.matched) {
    if (peerTerm > localTerm) return adoptPeerJournal(peer);
    throw new Error('conflict: state hash mismatch');
  }

  world = result.world;
  lastSyncAt = Date.now();
  lastSyncedTick = world.tick;
  lastSyncError = '';
  return { applied: true, tick: world.tick };
}

// 租约到期后的接管：不是抢写，而是把“第几任、谁是权威”记进日志。
// 只有当前权威按轮值顺序数过来的下一个节点先接手；再下一个多等一个 TAKEOVER_MS，
// 给更近的节点留出窗口。旧权威回来时会读到更高任期的记录，自动变成跟随者。
function attemptTakeover(now = Date.now()) {
  if (!PEER || syncFault) return false;
  const state = termState();
  if (state.authorityId === NODE_ID) return false;

  const seenAt = nodeLastSeen.get(state.authorityId) || startupAt;
  const silentFor = now - seenAt;
  const offset = takeoverOffset(state.authorityId);
  if (silentFor < TAKEOVER_MS * offset) return false;

  // 本周期刚拉过日志：只要有一个“还活着”的对端已经在更高任期，就让它先来。
  // 很久没联系上的旧 term 不算数，否则一次见过的高任期会把接管永久卡住。
  for (const health of peerHealth.values()) {
    if (now - health.lastSeenAt > LEASE_MS) continue;
    if (Number.isInteger(health.term) && health.term > state.term) return false;
  }

  const nextTerm = Math.max(state.term, state.baseTerm) + 1;
  logTermEvent(world, { term: nextTerm, authorityId: NODE_ID, reason: 'lease-expired' });
  saveWorld();
  lastTakeoverAt = now;
  lastSyncError = '';
  handoffReady = false;
  handoffStart = 0;
  console.log(
    `  租约到期：${state.authorityId} 已失联 ${Math.round(silentFor / 1000)}s，` +
      `${NODE_ID} 接任第 ${nextTerm} 任`
  );
  return true;
}

async function syncPeers() {
  if (!PEER || syncing || world.inflight > 0) return;
  syncing = true;

  let conflictThisCycle = false;
  let firstError = '';
  for (const peer of PEERS) {
    try {
      await pullFromPeer(peer);
    } catch (err) {
      const message = String(err?.message || err);
      if (!firstError) firstError = message;
      if (message.startsWith('conflict:')) {
        conflictThisCycle = true;
        if (!syncFault) syncFault = message;
      }
      const health = peerHealth.get(peer);
      if (health) health.error = message;
    }
  }

  lastSyncError = firstError;

  if (!PEER) {
    syncing = false;
    return;
  }

  const now = Date.now();
  attemptTakeover(now);

  const authorityId = authorityFor();
  if (isAuthority()) sawSelfAuthority = true;
  if (authorityId !== lastAuthorityId) {
    // 换任（正常轮换或接管）时必须重新交接：先追平，再等一个安静周期。
    lastAuthorityId = authorityId;
    handoffReady = false;
    handoffStart = 0;
  }

  if (!isAuthority()) {
    handoffReady = false;
    handoffStart = 0;
  } else if (syncFault) {
    handoffReady = false;
  } else {
    if (!handoffStart) handoffStart = now;
    // 对端失联不阻塞交接；只有真正的分叉冲突才要求停下。
    if (!conflictThisCycle && now - handoffStart >= HANDOFF_SETTLE_MS) handoffReady = true;
  }

  syncing = false;
}

// 24 倍：1 现实小时 = 1 世界日。按真实经过时间累积 tick，和离线推进同一把尺子。
let lastTickAt = Date.now();
let tickCarry = 0;
setInterval(() => {
  const now = Date.now();
  const elapsed = now - lastTickAt;
  lastTickAt = now;
  if (canAdvance()) {
    const speed = Math.max(1, world.config.speed | 0);
    tickCarry += elapsed * speed;
    while (tickCarry >= MS_PER_TICK) {
      stepWorld(world, 1);
      tickCarry -= MS_PER_TICK;
      if (!canAdvance()) {
        // 任期内事件数已经跨过边界，或节点失去权威，交给下一个节点。
        tickCarry = 0;
        break;
      }
    }
  } else {
    tickCarry = 0;
  }
  broadcast();
}, 250);

function saveWorld() {
  try {
    const payload = JSON.stringify({ savedAt: Date.now(), world: serializeWorld(world) });
    fs.writeFileSync(`${SAVE}.tmp`, payload);
    fs.renameSync(`${SAVE}.tmp`, SAVE);
  } catch (err) {
    console.error(`  存档写入失败：${err.message}`);
  }
}

setInterval(saveWorld, SAVE_INTERVAL_MS).unref();
// 守望心跳可能在两次点击之间过期；每秒核对一次，权威才会续租或让人睡着。
setInterval(() => reconcilePresence(), 1000).unref();
if (PEER) setInterval(syncPeers, SYNC_INTERVAL_MS).unref();
else if (PEER_URL && !MIRROR) setInterval(syncPeer, SYNC_INTERVAL_MS).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    saveWorld();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  const scheme = SECURE ? 'https' : 'http';
  console.log(`\n  最后的岛 · ${PEER ? '全节点' : MIRROR ? '镜像节点' : '独立节点'}`);
  console.log(`  ${NODE_ID} · seed ${world.seed} · ${scheme}://localhost:${PORT}`);
  console.log(
    `  身份：${identity.keyId} · 签名${VERIFY_SIGNATURES ? '校验开启' : '校验关闭'} · 信任 ${trust.size()} 个节点`
  );
  if (PEER) {
    console.log(
      `  peer 模式 · 节点 ${NODES.join(', ')} · 每 ${TERM_EVENTS} 条事件轮换 · 当前第 ${currentTerm()} 任：${authorityFor()}`
    );
    console.log(`  对端：${PEERS.length ? PEERS.join(', ') : '（无，单节点）'}`);
    if (!SYNC_TOKEN && !VERIFY_SIGNATURES) {
      console.warn('  警告：既没有 SYNC_TOKEN 也没有签名校验，其他节点无法向本节点写入日志。');
    }
    syncPeers();
  } else if (PEER_URL && !MIRROR) {
    console.log(`  同步目标：${PEER_URL} · 每 ${SYNC_INTERVAL_MS} ms 轮询`);
    syncPeer();
  }
  if (MIRROR && !SYNC_TOKEN && !VERIFY_SIGNATURES) {
    console.error('  警告：镜像节点既没有 SYNC_TOKEN 也没有签名校验，拒绝日志写入。');
  }
  console.log('');
});
