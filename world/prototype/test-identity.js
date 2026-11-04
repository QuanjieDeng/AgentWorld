// test-identity.js — 节点身份、日志信封签名、写入请求签名与重放保护。
// 最后一段启动一个真实进程：没有 SYNC_TOKEN，只靠签名写入日志。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stableStringify, exportJournal, eventsHash, hashText } from './sync.js';
import {
  ReplayGuard,
  TrustStore,
  generateNodeIdentity,
  keyIdFromPublicKey,
  loadOrCreateIdentity,
  signEnvelope,
  signIdentityDocument,
  signRequest,
  verifyEnvelopeSignature,
  verifyIdentityDocument,
} from './identity.js';

const SERVER = path.join(import.meta.dirname, 'server.js');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('节点身份落盘后复用同一把钥匙，换了 NODE_ID 就拒绝', () => {
  const dir = tempDir('island-identity-');
  try {
    const file = path.join(dir, 'node-key.json');
    const first = loadOrCreateIdentity({ file, nodeId: 'node-a' });
    assert.match(first.privateKey, /BEGIN PRIVATE KEY/);
    assert.equal(first.keyId, keyIdFromPublicKey(first.publicKey));

    const second = loadOrCreateIdentity({ file, nodeId: 'node-a' });
    assert.equal(second.publicKey.trim(), first.publicKey.trim());
    assert.equal(second.keyId, first.keyId);

    assert.throws(
      () => loadOrCreateIdentity({ file, nodeId: 'node-b' }),
      /belongs to node-a/
    );

    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.includes('PRIVATE KEY'), '密钥在本机文件里');
    assert.ok(!raw.includes('seed'), '身份文件只放密钥，不放世界数据');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('日志信封签名能发现字段篡改、错钥匙和冒名', () => {
  const dir = tempDir('island-envelope-');
  try {
    const mine = loadOrCreateIdentity({ file: path.join(dir, 'a.json'), nodeId: 'a' });
    const other = generateNodeIdentity('b');
    const envelope = signEnvelope(
      {
        protocol: 'island-journal/1',
        seed: 7,
        epoch: 1,
        fromSeq: 1,
        toSeq: 2,
        fromTick: 0,
        toTick: 10,
        prevHash: null,
        events: [],
        decisions: [],
        eventsHash: hashText('[]'),
        decisionsHash: hashText('[]'),
        stateHash: 'deadbeef',
      },
      mine
    );

    assert.equal(verifyEnvelopeSignature(envelope, mine.publicKey, { nodeId: 'a' }), true);
    assert.equal(verifyEnvelopeSignature(envelope, other.publicKey, { nodeId: 'b' }), false);
    assert.equal(verifyEnvelopeSignature(envelope, mine.publicKey, { nodeId: 'b' }), false);

    for (const field of ['eventsHash', 'stateHash', 'toSeq', 'prevHash']) {
      const tampered = structuredClone(envelope);
      tampered[field] = field === 'toSeq' ? 3 : `${tampered[field]}-tampered`;
      assert.equal(
        verifyEnvelopeSignature(tampered, mine.publicKey),
        false,
        `${field} 被改后签名必须失效`
      );
    }

    const unsigned = { ...envelope };
    delete unsigned.signature;
    assert.equal(verifyEnvelopeSignature(unsigned, mine.publicKey), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('身份自证绑定公钥和状态声明', () => {
  const identity = generateNodeIdentity('peer-x');
  const doc = signIdentityDocument(identity, {
    nodeId: 'peer-x',
    seed: 42,
    tick: 480,
    events: 12,
    journalHash: 'aaaa',
    stateHash: 'bbbb',
    term: 2,
    role: 'authority',
  });
  assert.equal(doc.keyId, keyIdFromPublicKey(doc.publicKey));
  assert.equal(verifyIdentityDocument(doc), true);

  const tampered = { ...doc, stateHash: 'cccc' };
  assert.equal(verifyIdentityDocument(tampered), false);

  const swappedKey = { ...doc, publicKey: generateNodeIdentity('z').publicKey };
  assert.equal(verifyIdentityDocument(swappedKey), false);

  const missingProof = { ...doc };
  delete missingProof.proof;
  assert.equal(verifyIdentityDocument(missingProof), false);
});

test('重放保护先验后记：伪造请求占不掉 nonce', () => {
  let now = 1_000_000;
  const guard = new ReplayGuard({ windowMs: 60_000, ttlMs: 300_000, now: () => now });
  const request = { nodeId: 'a', timestamp: now, nonce: 'nonce-0123456789' };

  assert.equal(guard.inspect(request).ok, true);
  // inspect 不记录，所以伪造者先发一次不会让真请求被判重放。
  assert.equal(guard.inspect(request).ok, true);
  assert.equal(guard.remember(request), true);
  assert.equal(guard.inspect(request).ok, false);
  assert.equal(guard.inspect(request).reason, 'replayed request');

  assert.equal(
    guard.inspect({ nodeId: 'a', timestamp: now - 120_000, nonce: 'another-nonce-1' }).ok,
    false
  );
  assert.equal(guard.inspect({ nodeId: 'a', timestamp: now, nonce: 'short' }).ok, false);

  // 窗口外的旧 nonce 会被清掉，不会无限增长。
  now += 400_000;
  assert.equal(guard.inspect({ nodeId: 'a', timestamp: now, nonce: 'nonce-0123456789' }).ok, true);
});

test('信任表首次固定，之后换钥匙一律拒绝，并能落盘重载', () => {
  const dir = tempDir('island-trust-');
  try {
    const file = path.join(dir, 'trust.json');
    const store = new TrustStore({ file });
    const a = generateNodeIdentity('a');
    const b = generateNodeIdentity('b');

    assert.equal(store.trust('a', a.publicKey).status, 'new');
    assert.equal(store.trust('a', a.publicKey).status, 'known');
    const mismatch = store.trust('a', b.publicKey);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.status, 'mismatch');

    const reloaded = new TrustStore({ file });
    assert.equal(reloaded.get('a').keyId, a.keyId);
    assert.equal(reloaded.trust('a', b.publicKey).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 真实进程：没有 token，只靠签名 ----------

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

async function waitFor(fn, { timeoutMs = 15_000, intervalMs = 100, detail = () => '' } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await delay(intervalMs);
  }
  throw new Error(`condition timed out ${detail()}`);
}

function launch({ port, dir, nodeId }) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      SEED: '313131',
      NODE_ID: nodeId,
      SAVE_FILE: path.join(dir, `${nodeId}.json`),
      NODE_KEY_FILE: path.join(dir, `key-${nodeId}.json`),
      TRUST_FILE: path.join(dir, `trust-${nodeId}.json`),
      SYNC_MODE: 'peer',
      NODES: nodeId,
      PEERS: '',
      SYNC_TOKEN: '', // 刻意不配 token：写入必须靠签名
      SYNC_INTERVAL_MS: '200',
      HANDOFF_SETTLE_MS: '0',
      SAVE_INTERVAL_MS: '1000',
      SPEED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk.toString()));
  child.stderr.on('data', (chunk) => (output += chunk.toString()));
  child.testOutput = () => output;
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, delay(1000)]);
  }
}

function emptyTailChunk(full, clientIdentity) {
  return signEnvelope(
    {
      protocol: full.protocol,
      seed: full.seed,
      nodeId: clientIdentity.nodeId,
      epoch: 1,
      fromSeq: full.toSeq + 1,
      toSeq: full.toSeq,
      fromTick: full.toTick,
      toTick: full.toTick,
      prevHash: full.eventsHash,
      events: [],
      decisions: [],
      eventsHash: eventsHash([]),
      decisionsHash: hashText(stableStringify([])),
      stateHash: full.stateHash,
      inflight: 0,
      ready: true,
      createdAt: full.createdAt,
    },
    clientIdentity
  );
}

function post(url, body, extraHeaders = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
}

test('没有 SYNC_TOKEN 时，签名请求可以写入，重放和篡改被拒绝', async (t) => {
  const dir = tempDir('island-signed-apply-');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = launch({ port, dir, nodeId: 'signed-node' });
  t.after(async () => {
    await stop(child);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const dump = () => child.testOutput();

  try {
    const ready = await waitFor(async () => {
      const res = await fetch(`${base}/api/identity`, { signal: AbortSignal.timeout(1000) });
      if (!res.ok) return null;
      const doc = await res.json();
      return doc.canWrite ? doc : null;
    }, { detail: dump });

    // 身份声明必须能自证，日志信封必须带可验证的签名。
    assert.equal(verifyIdentityDocument(ready), true);
    const journalRes = await fetch(`${base}/api/journal`);
    const full = await journalRes.json();
    assert.equal(verifyEnvelopeSignature(full, ready.publicKey, { nodeId: 'signed-node' }), true);

    // 暂停世界，保证导出的头部在请求期间不变。
    const paused = await post(`${base}/api/pause`, { paused: true });
    assert.equal(paused.status, 200);

    const client = generateNodeIdentity('signed-client');
    const chunk = emptyTailChunk(full, client);

    // 1. 完全没有授权 → 401（没有 token，也没有签名）。
    const anonymous = await post(`${base}/api/journal/apply`, chunk);
    assert.equal(anonymous.status, 401);

    // 2. 签名请求 → 200；本地世界追平到同一个头部。
    const headers = signRequest(client, {
      method: 'POST',
      path: '/api/journal/apply',
      body: chunk,
    });
    const accepted = await post(`${base}/api/journal/apply`, chunk, headers);
    const acceptedBody = await accepted.json();
    assert.equal(accepted.status, 200, JSON.stringify(acceptedBody));
    assert.equal(acceptedBody.ok, true);
    assert.equal(acceptedBody.stateHash, full.stateHash);

    // 3. 原样重放（同一个 nonce）→ 401。
    const replayed = await post(`${base}/api/journal/apply`, chunk, headers);
    assert.equal(replayed.status, 401);
    assert.equal((await replayed.json()).error, 'replayed request');

    // 4. 换了 body 却沿用旧签名 → 401。
    const tamperedChunk = structuredClone(chunk);
    tamperedChunk.stateHash = 'ffffffffffffffff';
    const tampered = await post(`${base}/api/journal/apply`, tamperedChunk, headers);
    assert.equal([401, 409].includes(tampered.status), true, `got ${tampered.status}`);

    // 5. 时间戳太旧 → 401。
    const staleHeaders = signRequest(client, {
      method: 'POST',
      path: '/api/journal/apply',
      body: chunk,
      timestamp: Date.now() - 10 * 60_000,
    });
    const stale = await post(`${base}/api/journal/apply`, chunk, staleHeaders);
    assert.equal(stale.status, 401);

    // 6. 请求签名者与日志签名者不是同一个节点 → 403。
    const impostor = generateNodeIdentity('signed-impostor');
    const foreignChunk = emptyTailChunk(full, impostor);
    const mismatchHeaders = signRequest(client, {
      method: 'POST',
      path: '/api/journal/apply',
      body: foreignChunk,
    });
    const mismatch = await post(`${base}/api/journal/apply`, foreignChunk, mismatchHeaders);
    const mismatchBody = await mismatch.json();
    assert.equal(mismatch.status, 403, JSON.stringify(mismatchBody));

    // 7. 信任表已经把客户端的钥匙固定下来，第二次请求不需要再出示公钥也能验。
    const pinned = JSON.parse(
      fs.readFileSync(path.join(dir, 'trust-signed-node.json'), 'utf8')
    );
    assert.equal(pinned.pins['signed-client'].keyId, client.keyId);
  } catch (err) {
    err.message += `\n${dump()}`;
    throw err;
  }
});
