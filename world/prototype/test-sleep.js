// test-sleep.js — 在线/睡眠轴：有人守着就醒着，租约到期回到规则驾驶。
//
// 关键点不是 UI，而是确定性：presence 必须写进事件日志，重放和追平后
// 每个节点对“谁醒着”的判断必须一致。

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
  decayRemembrance,
  setPresence,
} from './engine.js';
import { processBrains } from './brain.js';
import { exportJournal, rebuildFromJournal, applyChunk, cloneWorld, stateHash } from './sync.js';

const SERVER = path.join(import.meta.dirname, 'server.js');

function runTicks(world, n) {
  for (let i = 0; i < n; i++) {
    tick(world);
    processBrains(world);
  }
}

test('醒着的人不参与每日遗忘；租约到期后自动睡回去', () => {
  const world = createWorld(7);
  const a = world.agents[0];
  const until = world.tick + 5;
  const event = setPresence(world, a, {
    online: true,
    untilTick: until,
    by: 'viewer-1',
  });
  assert.equal(event.type, 'presence');
  assert.equal(event.payload.online, true);
  assert.equal(event.payload.by, 'viewer-1');
  assert.equal(a.presence, 'online');
  assert.equal(a.presenceUntil, until);

  a.remembrance = 10;
  decayRemembrance(world);
  assert.equal(a.remembrance, 10, '在线的人不应该被每日遗忘');

  runTicks(world, 5);
  assert.equal(a.presence, 'online', '租约还没到期');
  runTicks(world, 1);
  assert.equal(a.presence, 'offline', '租约到期后回到规则驾驶');
  assert.equal(a.presenceUntil, 0);

  const expired = world.eventLog.filter(
    (e) => e.type === 'presence' && e.payload?.reason === 'lease-expired'
  );
  assert.equal(expired.length, 1);
  assert.equal(expired[0].agentId, a.id);
});

test('续期会延长租约，并写进日志让别的节点看到', () => {
  const world = createWorld(7);
  const a = world.agents[0];
  setPresence(world, a, { online: true, untilTick: world.tick + 10 });
  const renewed = setPresence(world, a, { online: true, untilTick: world.tick + 30 });
  assert.ok(renewed, '续期应当留下事件');
  assert.equal(a.presenceUntil, world.tick + 30);

  // 更短的租约不会写日志，也不会缩短已有的租约。
  assert.equal(setPresence(world, a, { online: true, untilTick: world.tick + 20 }), null);
  assert.equal(a.presenceUntil, world.tick + 30);

  runTicks(world, 10);
  assert.equal(a.presence, 'online');
});

test('presence 事件能逐字节重放，租约到期也在同一个 tick 发生', () => {
  const world = createWorld(7);
  const a = world.agents[0];
  const until = world.tick + 20;
  setPresence(world, a, { online: true, untilTick: until, by: 'viewer-1' });
  runTicks(world, 10);

  const journal = exportJournal(world);
  const rebuilt = rebuildFromJournal(journal);
  assert.equal(stateHash(rebuilt), stateHash(world));
  const rebuiltAgent = rebuilt.agents.find((x) => x.id === a.id);
  assert.equal(rebuiltAgent.presence, 'online');
  assert.equal(rebuiltAgent.presenceUntil, until);

  runTicks(world, 15);
  runTicks(rebuilt, 15);
  assert.equal(
    world.agents.find((x) => x.id === a.id).presence,
    'offline',
    '原始世界应当在同一个 tick 睡回去'
  );
  assert.equal(stateHash(rebuilt), stateHash(world), '重放世界必须和原始世界一致');
});

test('追平一块带 presence 事件的日志后，状态哈希一致', () => {
  const early = createWorld(7);
  runTicks(early, 5);

  const late = cloneWorld(early);
  const a = late.agents[0];
  setPresence(late, a, { online: true, untilTick: late.tick + 30, by: 'viewer-2' });
  runTicks(late, 5);

  const chunk = exportJournal(late, { fromSeq: early.nextSeq });
  const result = applyChunk(early, chunk);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.matched, true);
  assert.equal(result.world.agents.find((x) => x.id === a.id).presence, 'online');
  assert.equal(stateHash(result.world), stateHash(late));
});

// ---------- HTTP：观看者心跳 ----------

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

function launch({ port, dir }) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      SEED: '919191',
      NODE_ID: 'sleep-node',
      SAVE_FILE: path.join(dir, 'save.json'),
      NODE_KEY_FILE: path.join(dir, 'key.json'),
      TRUST_FILE: path.join(dir, 'trust.json'),
      SYNC_INTERVAL_MS: '200',
      SAVE_INTERVAL_MS: '2000',
      SPEED: '8',
      TENDER_TTL_MS: '800',
      PRESENCE_LEASE_TICKS: '20',
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

async function getState(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`state HTTP ${res.status}`);
  return res.json();
}

test('守望心跳让人醒着，心跳失效后自动睡回去', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-island-sleep-'));
  const port = await freePort();
  const child = launch({ port, dir });
  t.after(async () => {
    await stop(child);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const dump = () => child.testOutput();

  try {
    await waitFor(async () => (await getState(port)) && true, { detail: dump });
    const state = await getState(port);
    const target = state.agents.find((a) => a.alive);
    assert.ok(target, '世界上应当有活人');

    const tend = await fetch(`${base}/api/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerId: 'sleep-test-viewer', agentId: target.id }),
    });
    const tendBody = await tend.json();
    assert.equal(tend.status, 200, JSON.stringify(tendBody));
    assert.equal(tendBody.presence, 'online');

    const lively = await getState(port);
    assert.equal(
      lively.agents.find((a) => a.id === target.id).presence,
      'online',
      '看守时应当醒着'
    );

    // 日志里应该有一条带观看者 id 的 presence 事件。
    const journal = await (await fetch(`${base}/api/journal`)).json();
    const presenceEvents = journal.events.filter((e) => e.type === 'presence');
    assert.ok(presenceEvents.length > 0, '应当写进事件日志');
    assert.equal(presenceEvents[presenceEvents.length - 1].payload.online, true);
    assert.equal(presenceEvents[presenceEvents.length - 1].payload.by, 'sleep-test-viewer');

    // 不再发心跳：TENDER_TTL 800ms 后，权威每秒核对一次会让人睡回去。
    const asleep = await waitFor(
      async () => {
        const s = await getState(port);
        const a = s.agents.find((x) => x.id === target.id);
        return a.presence === 'offline' ? s : null;
      },
      { timeoutMs: 6000, detail: dump }
    );
    assert.equal(asleep.agents.find((a) => a.id === target.id).presence, 'offline');

    // 再次守望，然后明确离开：应当立刻睡回去，不等租约。
    const again = await fetch(`${base}/api/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerId: 'sleep-test-viewer', agentId: target.id }),
    });
    assert.equal((await again.json()).presence, 'online');
    const leave = await fetch(`${base}/api/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerId: 'sleep-test-viewer', agentId: null }),
    });
    assert.equal(leave.status, 200);
    const after = await getState(port);
    assert.equal(after.agents.find((a) => a.id === target.id).presence, 'offline');
  } catch (err) {
    err.message += `\n${dump()}`;
    throw err;
  }
});
