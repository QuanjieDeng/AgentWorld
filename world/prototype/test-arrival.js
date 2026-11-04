// test-arrival.js — 真人上传：受控字段、轻量 PoW、创建者签名、引擎入口与重放。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createWorld,
  tick,
  admitArrival,
  validateArrivalCore,
  ORIGIN_KEYS,
  APTITUDE_KEYS,
  LANGUAGE_KEYS,
} from './engine.js';
import { processBrains } from './brain.js';
import {
  mineArrival,
  signArrival,
  verifyArrivalPoW,
  verifyArrivalRecord,
} from './arrival.js';
import { generateNodeIdentity } from './identity.js';
import {
  exportJournal,
  rebuildFromJournal,
  applyChunk,
  cloneWorld,
  stateHash,
} from './sync.js';

const SERVER = path.join(import.meta.dirname, 'server.js');

function validCore(overrides = {}) {
  return {
    name: '雾生',
    origin: ORIGIN_KEYS[0],
    aptitude: APTITUDE_KEYS[0],
    language: LANGUAGE_KEYS[0],
    obsession: '找到来处',
    wound: '忘了自己的名字',
    voice: '说话很轻，像怕吵醒谁',
    ...overrides,
  };
}

function runTicks(world, n) {
  for (let i = 0; i < n; i++) {
    tick(world);
    processBrains(world);
  }
}

test('上传字段只接受受控词表，并拒绝可识别的真实信息', () => {
  assert.equal(validateArrivalCore(validCore()).ok, true);

  assert.equal(validateArrivalCore(validCore({ origin: '外星人' })).ok, false);
  assert.equal(validateArrivalCore(validCore({ aptitude: '超能力' })).ok, false);
  assert.equal(validateArrivalCore(validCore({ language: '法语' })).ok, false);
  assert.equal(validateArrivalCore(validCore({ name: '这个名字实在是太长了' })).ok, false);
  assert.equal(validateArrivalCore(validCore({ name: '有 空格' })).ok, false);
  assert.equal(validateArrivalCore(validCore({ obsession: '' })).ok, false);
  assert.equal(validateArrivalCore(validCore({ wound: 'x'.repeat(41) })).ok, false);
  assert.equal(validateArrivalCore(validCore({ voice: '看 https://example.com' })).ok, false);
  assert.equal(validateArrivalCore(validCore({ voice: '联系我 someone@example.com' })).ok, false);
  assert.equal(validateArrivalCore(validCore({ wound: '电话 13812345678' })).ok, false);
});

test('PoW 可复算，创建者签名绑住字段', () => {
  const identity = generateNodeIdentity('arrival-a');
  const core = validCore();
  const pow = mineArrival(core, 3);
  assert.equal(verifyArrivalPoW(core, pow, 3), true);

  let badNonce = pow.nonce + 1;
  while (verifyArrivalPoW(core, { nonce: badNonce }, 3)) badNonce++;
  assert.equal(verifyArrivalPoW(core, { nonce: badNonce }, 3), false);

  const record = signArrival(identity, core, pow);
  assert.equal(verifyArrivalRecord(record, 3).ok, true);

  const renamed = { ...record, core: { ...record.core, name: '别人' } };
  assert.equal(verifyArrivalRecord(renamed, 3).ok, false);

  const badSignature = { ...record, signature: record.signature.slice(0, -4) + 'AAAA' };
  assert.equal(verifyArrivalRecord(badSignature, 3).ok, false);

  const swappedCreator = {
    ...record,
    creator: { ...record.creator, keyId: generateNodeIdentity('x').keyId },
  };
  assert.equal(verifyArrivalRecord(swappedCreator, 3).ok, false);
});

test('上传后世界里多一个人，重名被拒绝', () => {
  const world = createWorld(7);
  const identity = generateNodeIdentity('arrival-a');
  const core = validCore();
  const record = signArrival(identity, core, mineArrival(core, 2));

  const before = world.agents.length;
  const result = admitArrival(world, record);
  assert.equal(result.ok, true, result.reason);
  const agent = result.agent;
  assert.equal(world.agents.length, before + 1);
  assert.equal(agent.name, core.name);
  assert.equal(agent.tags.origin, core.origin);
  assert.equal(agent.tags.aptitude, core.aptitude);
  assert.equal(agent.tags.obsession, core.obsession);
  assert.equal(agent.voice, core.voice);
  assert.equal(agent.nativeLanguage, core.language);
  assert.equal(agent.arrivedBy, 'arrival-a');
  assert.ok(world.eventLog.some((e) => e.type === 'arrival' && e.agentId === agent.id));

  const duplicatePow = mineArrival(core, 2);
  const duplicate = admitArrival(world, signArrival(identity, core, duplicatePow));
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.reason, /名字/);
});

test('arrival 事件能逐字节重放，落点与属性一致', () => {
  const world = createWorld(7);
  const identity = generateNodeIdentity('arrival-a');
  const core = validCore();
  runTicks(world, 5);
  const result = admitArrival(world, signArrival(identity, core, mineArrival(core, 2)));
  assert.equal(result.ok, true, result.reason);
  runTicks(world, 8);

  const journal = exportJournal(world);
  const rebuilt = rebuildFromJournal(journal);
  assert.equal(stateHash(rebuilt), stateHash(world));

  const original = world.agents.find((a) => a.name === core.name);
  const restored = rebuilt.agents.find((a) => a.name === core.name);
  assert.ok(restored, '重放后应当还有这个人');
  assert.equal(restored.id, original.id);
  assert.equal(restored.x, original.x);
  assert.equal(restored.y, original.y);
  assert.equal(restored.voice, original.voice);
  assert.equal(restored.arrivedBy, original.arrivedBy);
  assert.ok(rebuilt.eventLog.some((e) => e.type === 'arrival'));
});

test('追平一块带 arrival 的日志后状态哈希一致', () => {
  const early = createWorld(7);
  runTicks(early, 5);
  const late = cloneWorld(early);
  const identity = generateNodeIdentity('arrival-b');
  const core = validCore({ name: '听潮' });
  assert.equal(
    admitArrival(late, signArrival(identity, core, mineArrival(core, 2))).ok,
    true
  );
  runTicks(late, 5);

  const chunk = exportJournal(late, { fromSeq: early.nextSeq });
  const result = applyChunk(early, chunk);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.matched, true);
  assert.ok(result.world.agents.some((a) => a.name === '听潮'));
  assert.equal(stateHash(result.world), stateHash(late));
});

// ---------- HTTP ----------

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

async function waitFor(fn, { timeoutMs = 12_000, intervalMs = 100, detail = () => '' } = {}) {
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

function launch({ port, dir, nodeId = 'arrival-node', extraEnv = {} }) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      SEED: '737373',
      NODE_ID: nodeId,
      SAVE_FILE: path.join(dir, 'save.json'),
      NODE_KEY_FILE: path.join(dir, 'key.json'),
      TRUST_FILE: path.join(dir, 'trust.json'),
      ARRIVAL_DIFFICULTY: '2',
      SYNC_INTERVAL_MS: '200',
      SAVE_INTERVAL_MS: '2000',
      SPEED: '8',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk.toString()));
  child.stderr.on('data', (chunk) => (output += chunk.toString()));
  child.testOutput = () => output;
  return child;
}

function launchPeer({ port, dir, nodeId, peering }) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      SEED: '747474',
      NODE_ID: nodeId,
      SAVE_FILE: path.join(dir, `${nodeId}.json`),
      NODE_KEY_FILE: path.join(dir, `key-${nodeId}.json`),
      TRUST_FILE: path.join(dir, `trust-${nodeId}.json`),
      SYNC_MODE: 'peer',
      NODES: 'peer-a,peer-b',
      PEERS: peering,
      SYNC_TOKEN: 'arrival-peer-token',
      TERM_EVENTS: '100000',
      LEASE_MS: '6000',
      TAKEOVER_MS: '12000',
      ARRIVAL_DIFFICULTY: '2',
      SYNC_INTERVAL_MS: '120',
      HANDOFF_SETTLE_MS: '250',
      SAVE_INTERVAL_MS: '2000',
      SPEED: '8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk.toString()));
  child.stderr.on('data', (chunk) => (output += chunk.toString()));
  child.testOutput = () => output;
  return child;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.json();
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

test('通过 HTTP 上传：配置、PoW、签名、落世界与重放', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-island-arrival-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = launch({ port, dir });
  t.after(async () => {
    await stop(child);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const dump = () => child.testOutput();

  try {
    const config = await waitFor(
      async () => {
        const res = await fetch(`${base}/api/arrival`);
        if (!res.ok) return null;
        const data = await res.json();
        return data.ok ? data : null;
      },
      { detail: dump }
    );
    assert.equal(config.difficulty, 2);
    assert.ok(config.origins.includes(ORIGIN_KEYS[0]));
    assert.ok(config.aptitudes.length >= 1);
    assert.ok(config.languages.includes(LANGUAGE_KEYS[0]));
    assert.match(config.notice, /不可删除/);

    const core = validCore();
    const pow = mineArrival(core, config.difficulty);
    const res = await fetch(`${base}/api/arrival`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ core, pow }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.ok(body.agentId);

    const state = await (await fetch(`${base}/api/state`)).json();
    const agent = state.agents.find((a) => a.name === core.name);
    assert.ok(agent, '上传的人应当出现在世界里');
    assert.equal(agent.voice, core.voice);
    assert.equal(agent.arrivedBy, 'arrival-node');

    // 日志里有一条能被独立验签的 arrival 记录。
    const journal = await (await fetch(`${base}/api/journal`)).json();
    const event = journal.events.find((e) => e.type === 'arrival');
    assert.ok(event, '应当写进事件日志');
    assert.equal(verifyArrivalRecord(event.payload.arrival, config.difficulty).ok, true);
    assert.equal(event.payload.arrival.creator.nodeId, 'arrival-node');

    // 重名与坏 PoW 都会被拒绝。
    const duplicate = await fetch(`${base}/api/arrival`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ core, pow: mineArrival(core, config.difficulty) }),
    });
    assert.equal(duplicate.status, 409);

    // 一个节点只能上传一个人，换名字也不行。
    const secondCore = validCore({ name: '第二人' });
    const second = await fetch(`${base}/api/arrival`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        core: secondCore,
        pow: mineArrival(secondCore, config.difficulty),
      }),
    });
    assert.equal(second.status, 409);
    assert.match((await second.json()).error, /已经上传过/);
    const afterConfig = await (await fetch(`${base}/api/arrival`)).json();
    assert.equal(afterConfig.hasUploaded, true);

    const badPow = await fetch(`${base}/api/arrival`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ core: { ...core, name: '另一个' }, pow: { nonce: 0, difficulty: 2 } }),
    });
    assert.equal(badPow.status, 400);

    // 暂停后从日志重建，状态哈希必须和节点一致。
    await fetch(`${base}/api/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    });
    const finalJournal = await (await fetch(`${base}/api/journal`)).json();
    const identity = await (await fetch(`${base}/api/identity`)).json();
    const rebuilt = rebuildFromJournal(finalJournal);
    assert.equal(stateHash(rebuilt), identity.stateHash);
    assert.equal(
      rebuilt.agents.find((a) => a.name === core.name)?.id,
      agent.id
    );
  } catch (err) {
    err.message += `\n${dump()}`;
    throw err;
  }
});

test('跟随节点收到上传后转发给当前权威，两边都长出新的人', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-island-arrival-peer-'));
  const portA = await freePort();
  const portB = await freePort();
  const urlA = `http://127.0.0.1:${portA}`;
  const urlB = `http://127.0.0.1:${portB}`;
  const a = launchPeer({ port: portA, dir, nodeId: 'peer-a', peering: urlB });
  const b = launchPeer({ port: portB, dir, nodeId: 'peer-b', peering: urlA });
  t.after(async () => {
    await stop(a);
    await stop(b);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const dump = () => `peer-a:\n${a.testOutput()}\npeer-b:\n${b.testOutput()}`;

  try {
    // peer-a 从第 0 任开始就是权威；等 peer-b 记住它的地址。
    await waitFor(
      async () => {
        const [ia, ib] = await Promise.all([
          getJson(`${urlA}/api/identity`),
          getJson(`${urlB}/api/identity`),
        ]);
        return ia.canWrite &&
          ib.authorityId === 'peer-a' &&
          ib.peerHealth.some((h) => h.nodeId === 'peer-a' && !h.error)
          ? ib
          : null;
      },
      { detail: dump }
    );

    const core = validCore({ name: '摆渡' });
    const pow = mineArrival(core, 2);
    const res = await fetch(`${urlB}/api/arrival`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ core, pow }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.creator, 'peer-b', '记录应当由上传者所在的节点签名');

    await waitFor(
      async () => {
        const [sa, sb] = await Promise.all([
          getJson(`${urlA}/api/state`),
          getJson(`${urlB}/api/state`),
        ]);
        return sa.agents.some((x) => x.name === '摆渡') &&
          sb.agents.some((x) => x.name === '摆渡')
          ? { sa, sb }
          : null;
      },
      { detail: dump }
    );

    await waitFor(
      async () => {
        const [ia, ib] = await Promise.all([
          getJson(`${urlA}/api/identity`),
          getJson(`${urlB}/api/identity`),
        ]);
        return ia.events === ib.events &&
          ia.stateHash === ib.stateHash &&
          ia.term === ib.term
          ? true
          : null;
      },
      { detail: dump }
    );
  } catch (err) {
    err.message += `\n${dump()}`;
    throw err;
  }
});

test('关闭节点级限制后，玩家 id 仍然只能上传一次', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-island-arrival-player-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = launch({ port, dir, extraEnv: { ARRIVAL_ONCE_PER_NODE: '0' } });
  t.after(async () => {
    await stop(child);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const dump = () => child.testOutput();

  try {
    await waitFor(
      async () => {
        const res = await fetch(`${base}/api/arrival`);
        return res.ok ? true : null;
      },
      { detail: dump }
    );

    async function upload(name, playerId) {
      const core = validCore({ name });
      const res = await fetch(`${base}/api/arrival`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          core,
          pow: mineArrival(core, 2),
          ...(playerId ? { playerId } : {}),
        }),
      });
      return { status: res.status, body: await res.json() };
    }

    const first = await upload('甲舟', 'player-one');
    assert.equal(first.status, 200, JSON.stringify(first.body));

    const samePlayer = await upload('乙舟', 'player-one');
    assert.equal(samePlayer.status, 409);
    assert.match(samePlayer.body.error, /玩家/);

    const secondPlayer = await upload('丙舟', 'player-two');
    assert.equal(secondPlayer.status, 200, JSON.stringify(secondPlayer.body));

    const noPlayer = await upload('丁舟', null);
    assert.equal(noPlayer.status, 200, JSON.stringify(noPlayer.body));

    const journal = await (await fetch(`${base}/api/journal`)).json();
    const arrivals = journal.events.filter((e) => e.type === 'arrival');
    assert.equal(arrivals.length, 3);
    assert.deepEqual(
      arrivals.map((e) => e.payload.arrival.creator.playerId),
      ['player-one', 'player-two', null]
    );
    for (const event of arrivals) {
      assert.equal(verifyArrivalRecord(event.payload.arrival, 2).ok, true);
    }
  } catch (err) {
    err.message += `\n${dump()}`;
    throw err;
  }
});
