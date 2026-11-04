// test-owner.js — 主人节点的提案：上传者替自己的居民想好下一步，
// 签名交给当前权威；权威重新校验、排队，并在决策时写进日志（source: owner）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mineArrival, signArrival } from './arrival.js';
import { generateNodeIdentity, signRequest } from './identity.js';

const SERVER = path.join(import.meta.dirname, 'server.js');

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

async function waitFor(fn, { timeoutMs = 25_000, intervalMs = 100, detail = () => '' } = {}) {
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

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.json();
}

async function post(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

function launch({ port, dir, nodeId, peering = '', peerMode = false }) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      SEED: '858585',
      NODE_ID: nodeId,
      SAVE_FILE: path.join(dir, `${nodeId}.json`),
      NODE_KEY_FILE: path.join(dir, `key-${nodeId}.json`),
      TRUST_FILE: path.join(dir, `trust-${nodeId}.json`),
      SYNC_MODE: peerMode ? 'peer' : 'standalone',
      NODES: peerMode ? 'peer-a,peer-b' : nodeId,
      PEERS: peering,
      SYNC_TOKEN: 'owner-test-token',
      TERM_EVENTS: '100000',
      LEASE_MS: '6000',
      TAKEOVER_MS: '12000',
      ARRIVAL_DIFFICULTY: '2',
      OWNER_INTENT_INTERVAL_MS: '300',
      SYNC_INTERVAL_MS: '100',
      HANDOFF_SETTLE_MS: '250',
      SAVE_INTERVAL_MS: '2000',
      SPEED: '4',
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

function core(name) {
  return {
    name,
    origin: '渔夫',
    aptitude: '体魄',
    language: 'south',
    obsession: '回到海的那一边',
    wound: '船沉了，儿子没上来',
    voice: '说话像潮水',
  };
}

test('主人节点的提案在权威端被校验、排队并写进决策日志', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-island-owner-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = launch({ port, dir, nodeId: 'host-node' });
  t.after(async () => {
    await stop(child);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const dump = () => child.testOutput();

  try {
    await waitFor(async () => (await getJson(`${base}/api/identity`)).canWrite, { detail: dump });

    const owner = generateNodeIdentity('owner-1');
    const arrivalCore = core('归舟');
    const record = signArrival(owner, arrivalCore, mineArrival(arrivalCore, 2));
    const publishHeaders = signRequest(owner, {
      method: 'POST',
      path: '/api/arrival/publish',
      body: record,
    });
    const published = await post(`${base}/api/arrival/publish`, record, publishHeaders);
    const publishedBody = await published.json();
    assert.equal(published.status, 200, JSON.stringify(publishedBody));
    const agentId = publishedBody.agentId;

    const state = await getJson(`${base}/api/state`);
    const agent = state.agents.find((a) => a.id === agentId);
    assert.equal(agent.arrivedBy, 'owner-1');

    // 暂停，确保提案先于下一次决策到达。
    await post(`${base}/api/pause`, { paused: true });
    const current = await getJson(`${base}/api/identity`);
    const intent = {
      agentId,
      action: { type: 'move', dir: 'E' },
      basedOnTick: current.tick,
    };
    const intentHeaders = signRequest(owner, { method: 'POST', path: '/api/intent', body: intent });
    const queued = await post(`${base}/api/intent`, intent, intentHeaders);
    const queuedBody = await queued.json();
    assert.equal(queued.status, 200, JSON.stringify(queuedBody));
    assert.equal(queuedBody.queued, true);
    assert.equal(queuedBody.presence, 'online', '提案应当顺手续上清醒租约');

    // 不是主人就不能替别人做决定。
    const stranger = generateNodeIdentity('stranger-1');
    const strangerHeaders = signRequest(stranger, {
      method: 'POST',
      path: '/api/intent',
      body: intent,
    });
    const rejected = await post(`${base}/api/intent`, intent, strangerHeaders);
    assert.equal(rejected.status, 403);

    // 受控动作之外的 JSON 进不了引擎。
    const bad = { agentId, action: { type: 'teleport' }, basedOnTick: current.tick };
    const badHeaders = signRequest(owner, { method: 'POST', path: '/api/intent', body: bad });
    const badRes = await post(`${base}/api/intent`, bad, badHeaders);
    assert.equal(badRes.status, 400);

    await post(`${base}/api/pause`, { paused: false });

    const decided = await waitFor(
      async () => {
        const journal = await getJson(`${base}/api/journal`);
        return (
          journal.events.find(
            (e) => e.type === 'decision' && e.agentId === agentId && e.payload?.source === 'owner'
          ) || null
        );
      },
      { detail: dump }
    );
    assert.equal(decided.payload.action.type, 'move');
    assert.equal(decided.payload.action.dir, 'E');

    // 主人在线但没有新提案时，居民应当发呆等待，而不是被规则接手。
    const waited = await waitFor(
      async () => {
        const journal = await getJson(`${base}/api/journal`);
        return (
          journal.events.find(
            (e) =>
              e.type === 'decision' &&
              e.agentId === agentId &&
              e.payload?.source === 'owner-wait'
          ) || null
        );
      },
      { detail: dump }
    );
    assert.equal(waited.payload.action.type, 'idle');
    assert.match(waited.payload.action.reason || '', /主人/);
  } catch (err) {
    err.message += `\n${dump()}`;
    throw err;
  }
});

test('跟随节点替自己的居民自动提案，权威只负责记录', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-island-owner-peer-'));
  const portA = await freePort();
  const portB = await freePort();
  const urlA = `http://127.0.0.1:${portA}`;
  const urlB = `http://127.0.0.1:${portB}`;
  const a = launch({ port: portA, dir, nodeId: 'peer-a', peering: urlB, peerMode: true });
  const b = launch({ port: portB, dir, nodeId: 'peer-b', peering: urlA, peerMode: true });
  t.after(async () => {
    await stop(a);
    await stop(b);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const dump = () => `peer-a:\n${a.testOutput()}\npeer-b:\n${b.testOutput()}`;

  try {
    await waitFor(
      async () => {
        const [ia, ib] = await Promise.all([
          getJson(`${urlA}/api/identity`),
          getJson(`${urlB}/api/identity`),
        ]);
        return ia.canWrite &&
          ib.authorityId === 'peer-a' &&
          ib.peerHealth.some((h) => h.nodeId === 'peer-a' && !h.error)
          ? true
          : null;
      },
      { detail: dump }
    );

    // 从跟随节点上传，创建者就是 peer-b。
    const arrivalCore = core('听涛');
    const pow = mineArrival(arrivalCore, 2);
    const uploaded = await post(`${urlB}/api/arrival`, { core: arrivalCore, pow });
    const uploadedBody = await uploaded.json();
    assert.equal(uploaded.status, 200, JSON.stringify(uploadedBody));
    assert.equal(uploadedBody.creator, 'peer-b');
    const agentId = uploadedBody.agentId;

    await waitFor(
      async () => {
        const s = await getJson(`${urlB}/api/state`);
        return s.agents.find((x) => x.id === agentId) || null;
      },
      { detail: dump }
    );

    // peer-b 的主人循环会自动生成提案并发给 peer-a；等一条 source=owner 的决策。
    const decided = await waitFor(
      async () => {
        const journal = await getJson(`${urlA}/api/journal`);
        return (
          journal.events.find(
            (e) => e.type === 'decision' && e.agentId === agentId && e.payload?.source === 'owner'
          ) || null
        );
      },
      { timeoutMs: 30_000, detail: dump }
    );
    assert.ok(decided.payload.action);

    // 暂停权威，等跟随者追平后再比较，避免把正常的同步延迟当成分叉。
    await post(`${urlA}/api/pause`, { paused: true });
    let lastPair = null;
    const converged = await waitFor(
      async () => {
        const [ia, ib] = await Promise.all([
          getJson(`${urlA}/api/identity`),
          getJson(`${urlB}/api/identity`),
        ]);
        lastPair = { ia, ib };
        return ia.events === ib.events && ia.stateHash === ib.stateHash ? { ia, ib } : null;
      },
      {
        timeoutMs: 20_000,
        detail: () =>
          `${dump()}\nlast pair:\n${JSON.stringify(lastPair, null, 2)}`,
      }
    );
    assert.equal(converged.ia.stateHash, converged.ib.stateHash);
    assert.equal(converged.ia.events, converged.ib.events);
  } catch (err) {
    err.message += `\n${dump()}`;
    throw err;
  }
});
