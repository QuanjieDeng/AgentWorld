// test-network-sync.js — 启动两个真实 HTTP 进程，验证轮询同步与断线重连。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const SERVER = path.join(import.meta.dirname, 'server.js');
const TOKEN = 'test-only-sync-token-0123456789';

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

function launch({ port, saveFile, nodeId, mirror = false, peerUrl = '', keyFile, trustFile }) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      SEED: '97123',
      NODE_ID: nodeId,
      SAVE_FILE: saveFile,
      NODE_KEY_FILE: keyFile,
      TRUST_FILE: trustFile,
      MIRROR: mirror ? '1' : '0',
      PEER_URL: peerUrl,
      SYNC_TOKEN: TOKEN,
      SYNC_INTERVAL_MS: '100',
      SAVE_INTERVAL_MS: '500',
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
    signal: AbortSignal.timeout(1000),
  });
  if (!res.ok) throw new Error(`identity HTTP ${res.status}`);
  return res.json();
}

async function waitFor(fn, { timeoutMs = 12_000, intervalMs = 100, detail = () => '' } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      // A just-started or reconnecting process may not be listening yet.
    }
    await delay(intervalMs);
  }
  throw new Error(`condition timed out ${detail()}`);
}

test('两节点通过 HTTP 轮询追平，镜像重启后自动恢复同步', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-island-sync-'));
  const primarySave = path.join(dir, 'primary.json');
  const mirrorSave = path.join(dir, 'mirror.json');
  const primaryPort = await freePort();
  let mirrorPort = await freePort();
  const peerUrl = `http://127.0.0.1:${mirrorPort}`;

  let primary = launch({
    port: primaryPort,
    saveFile: primarySave,
    nodeId: 'primary-test',
    peerUrl,
    keyFile: path.join(dir, 'key-primary.json'),
    trustFile: path.join(dir, 'trust-primary.json'),
  });
  let mirror = launch({
    port: mirrorPort,
    saveFile: mirrorSave,
    nodeId: 'mirror-test',
    mirror: true,
    keyFile: path.join(dir, 'key-mirror.json'),
    trustFile: path.join(dir, 'trust-mirror.json'),
  });
  t.after(async () => {
    await stop(primary);
    await stop(mirror);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  try {
    await waitFor(async () => {
      const [a, b] = await Promise.all([identity(primaryPort), identity(mirrorPort)]);
      return a.seed === b.seed ? true : null;
    });

    await fetch(`http://127.0.0.1:${primaryPort}/api/speed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speed: 8 }),
    });

    await waitFor(async () => {
      const [a, b] = await Promise.all([identity(primaryPort), identity(mirrorPort)]);
      return a.tick > 480 && a.stateHash === b.stateHash ? { a, b } : null;
    }, {
      detail: () => `primary: ${primary.testOutput()}\nmirror: ${mirror.testOutput()}`,
    });

    // 镜像是只读节点，并且要求 bearer token。
    const readonly = await fetch(`http://127.0.0.1:${mirrorPort}/api/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    });
    assert.equal(readonly.status, 403);

    const unauthorized = await fetch(`http://127.0.0.1:${mirrorPort}/api/journal/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(unauthorized.status, 401);

    await stop(mirror);
    mirror = null;
    await delay(1200);

    // 固定 PEER_URL 端口必须不变，镜像重启后继续监听原端口。
    mirrorPort = Number(new URL(peerUrl).port);
    mirror = launch({
      port: mirrorPort,
      saveFile: mirrorSave,
      nodeId: 'mirror-test',
      mirror: true,
      keyFile: path.join(dir, 'key-mirror.json'),
      trustFile: path.join(dir, 'trust-mirror.json'),
    });

    const caughtUp = await waitFor(async () => {
      const [a, b] = await Promise.all([identity(primaryPort), identity(mirrorPort)]);
      return a.tick > 480 && a.stateHash === b.stateHash ? { a, b } : null;
    }, {
      timeoutMs: 15_000,
      detail: () => `primary: ${primary.testOutput()}\nmirror: ${mirror?.testOutput() || 'restarting'}`,
    });

    assert.equal(caughtUp.a.seed, caughtUp.b.seed);
    assert.equal(caughtUp.a.stateHash, caughtUp.b.stateHash);
    assert.equal(caughtUp.a.events, caughtUp.b.events);
    assert.ok(caughtUp.b.lastSyncAt, '镜像记录了最近同步时间');
    assert.equal(caughtUp.b.lastSyncError, '');
  } catch (err) {
    err.message += `\nprimary output:\n${primary.testOutput()}\nmirror output:\n${mirror?.testOutput() || 'stopped'}`;
    throw err;
  }
});
