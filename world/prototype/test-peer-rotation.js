// test-peer-rotation.js — 两个全节点双向拉日志，按事件数轮换日志权威。
// 这是一个真实的两进程集成测试：没有主节点，只有当前 term 的写入者。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const SERVER = path.join(import.meta.dirname, 'server.js');
const TOKEN = 'peer-rotation-test-token-0123456789';
const SEED = '424242';
const TERM_EVENTS = '40';

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

function launch({ port, saveFile, nodeId, peering, keyFile, trustFile }) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      SEED,
      NODE_ID: nodeId,
      SAVE_FILE: saveFile,
      NODE_KEY_FILE: keyFile,
      TRUST_FILE: trustFile,
      SYNC_MODE: 'peer',
      NODES: 'peer-a,peer-b',
      PEERS: peering,
      TERM_EVENTS,
      SYNC_INTERVAL_MS: '100',
      HANDOFF_SETTLE_MS: '400',
      SAVE_INTERVAL_MS: '1000',
      SPEED: '8',
      SYNC_TOKEN: TOKEN,
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

async function identity(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/identity`, {
    signal: AbortSignal.timeout(1500),
  });
  if (!res.ok) throw new Error(`identity HTTP ${res.status}`);
  return res.json();
}

async function waitFor(fn, { timeoutMs = 20_000, intervalMs = 100, detail = () => '' } = {}) {
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

function noteFaults(a, b) {
  if (a.syncFault || b.syncFault) {
    throw new Error(`sync fault: ${a.syncFault || b.syncFault}`);
  }
}

test('两个全节点轮流写入，并在每个任期后收敛', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-island-peer-'));
  const portA = await freePort();
  const portB = await freePort();
  const urlA = `http://127.0.0.1:${portA}`;
  const urlB = `http://127.0.0.1:${portB}`;

  const a = launch({
    port: portA,
    saveFile: path.join(dir, 'peer-a.json'),
    nodeId: 'peer-a',
    peering: urlB,
    keyFile: path.join(dir, 'key-peer-a.json'),
    trustFile: path.join(dir, 'trust-peer-a.json'),
  });
  const b = launch({
    port: portB,
    saveFile: path.join(dir, 'peer-b.json'),
    nodeId: 'peer-b',
    peering: urlA,
    keyFile: path.join(dir, 'key-peer-b.json'),
    trustFile: path.join(dir, 'trust-peer-b.json'),
  });
  t.after(async () => {
    await stop(a);
    await stop(b);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const dump = () => `peer-a:\n${a.testOutput()}\npeer-b:\n${b.testOutput()}`;

  try {
    await waitFor(async () => {
      const [ia, ib] = await Promise.all([identity(portA), identity(portB)]);
      return ia.seed === ib.seed ? true : null;
    }, { detail: dump });

    const initial = await waitFor(async () => {
      const [ia, ib] = await Promise.all([identity(portA), identity(portB)]);
      noteFaults(ia, ib);
      return ia.tick > 480 && ia.events === ib.events && ia.stateHash === ib.stateHash
        ? { a: ia, b: ib }
        : null;
    }, { detail: dump });

    // 等两个节点都担任过一次排序节点，证明 authority 真的在轮换。
    const authorities = new Set([initial.a.authorityId]);
    await waitFor(async () => {
      const [ia, ib] = await Promise.all([identity(portA), identity(portB)]);
      noteFaults(ia, ib);
      authorities.add(ia.authorityId);
      authorities.add(ib.authorityId);
      return authorities.has('peer-a') && authorities.has('peer-b') ? true : null;
    }, { timeoutMs: 25_000, detail: dump });

    const converged = await waitFor(async () => {
      const [ia, ib] = await Promise.all([identity(portA), identity(portB)]);
      noteFaults(ia, ib);
      return ia.tick > 500 &&
        ia.events === ib.events &&
        ia.term === ib.term &&
        ia.stateHash === ib.stateHash
        ? { a: ia, b: ib }
        : null;
    }, { timeoutMs: 25_000, detail: dump });

    assert.equal(converged.a.stateHash, converged.b.stateHash);
    assert.equal(converged.a.journalHash, converged.b.journalHash);
    assert.equal(converged.a.events, converged.b.events);
    assert.equal(converged.a.term, converged.b.term);
    assert.ok(converged.a.events > initial.a.events, '轮换期间世界应当继续前进');
    assert.ok(converged.a.term >= 1, '至少发生过一次任期轮换');
    assert.equal(converged.a.syncFault, null);
    assert.equal(converged.b.syncFault, null);

    // 两个节点都曾在某个时刻持有写入权。
    const [ia, ib] = await Promise.all([identity(portA), identity(portB)]);
    const wrote = [ia, ib].filter((x) => x.canWrite);
    assert.ok(wrote.length <= 1, '同一时刻最多一个节点持有写入权');
    assert.ok(ia.nodes.includes('peer-a') && ia.nodes.includes('peer-b'));
  } catch (err) {
    err.message += `\n${dump()}`;
    throw err;
  }
});
