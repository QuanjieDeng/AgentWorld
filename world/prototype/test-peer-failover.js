// test-peer-failover.js — 当前权威失联后，租约到期，轮值里的下一个节点接任；
// 旧权威回归时读到更高任期，只做跟随者，不重新夺权。
// 两个真实进程，宕机/恢复都是进程级操作。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const SERVER = path.join(import.meta.dirname, 'server.js');
const TOKEN = 'peer-failover-test-token-0123456789';
const SEED = '515151';

// 每个节点用自己的密钥文件和信任表；重启时复用同一个密钥，否则信任表会拒绝它。
function paths(dir, nodeId) {
  return {
    keyFile: path.join(dir, `key-${nodeId}.json`),
    trustFile: path.join(dir, `trust-${nodeId}.json`),
  };
}
// 故意把轮换周期设得很长：接管只可能由租约到期触发，断言才不含糊。
const TERM_EVENTS = '1000';

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

function launch({ port, saveFile, nodeId, peering, keyFile, trustFile, syncIntervalMs = 100 }) {
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
      SYNC_INTERVAL_MS: String(syncIntervalMs),
      HANDOFF_SETTLE_MS: '250',
      LEASE_MS: '800',
      TAKEOVER_MS: '1600',
      SAVE_INTERVAL_MS: '500',
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

test('权威失联后下一节点接任，旧权威回归后只读', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-island-failover-'));
  const portA = await freePort();
  const portB = await freePort();
  const urlA = `http://127.0.0.1:${portA}`;
  const urlB = `http://127.0.0.1:${portB}`;
  const saveA = path.join(dir, 'peer-a.json');
  const saveB = path.join(dir, 'peer-b.json');

  const procs = {
    a: launch({ port: portA, saveFile: saveA, nodeId: 'peer-a', peering: urlB, ...paths(dir, 'peer-a') }),
    b: launch({ port: portB, saveFile: saveB, nodeId: 'peer-b', peering: urlA, ...paths(dir, 'peer-b') }),
  };
  t.after(async () => {
    await stop(procs.a);
    await stop(procs.b);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const dump = () => `peer-a:\n${procs.a.testOutput()}\npeer-b:\n${procs.b.testOutput()}`;

  try {
    // 1. 两个节点先收敛。
    const ready = await waitFor(
      async () => {
        const [ia, ib] = await Promise.all([identity(portA), identity(portB)]);
        return ia.events === ib.events &&
          ia.tick === ib.tick &&
          ia.stateHash === ib.stateHash &&
          (ia.canWrite || ib.canWrite)
          ? { ia, ib }
          : null;
      },
      { timeoutMs: 20_000, detail: dump }
    );
    assert.equal(ready.ia.syncFault, null);
    assert.equal(ready.ib.syncFault, null);

    // 2. 找到当前权威，把它杀掉。
    const victimIsA = ready.ia.authorityId === 'peer-a';
    const survivorId = victimIsA ? 'peer-b' : 'peer-a';
    const victimPort = victimIsA ? portA : portB;
    const survivorPort = victimIsA ? portB : portA;
    const before = victimIsA ? ready.ib : ready.ia;
    assert.equal(before.role, 'follower');

    if (victimIsA) await stop(procs.a);
    else await stop(procs.b);

    // 3. 租约到期后，下一个节点接任并继续推进。
    const taken = await waitFor(
      async () => {
        const s = await identity(survivorPort);
        assert.equal(s.syncFault, null);
        return s.authorityId === survivorId && s.term > before.term && s.canWrite && s.tick > before.tick
          ? s
          : null;
      },
      { timeoutMs: 15_000, detail: dump }
    );
    assert.equal(taken.role, 'authority');
    assert.ok(taken.lastTakeoverAt, '应当记录一次租约接管');
    assert.equal(taken.termSource, 'terms');
    assert.ok(taken.events > before.events, '接管后世界应当继续产生事件');

    // 4. 旧权威带着旧存档回来：读到更高任期后只读。
    if (victimIsA) {
      procs.a = launch({ port: victimPort, saveFile: saveA, nodeId: 'peer-a', peering: urlB, ...paths(dir, 'peer-a') });
    } else {
      procs.b = launch({ port: victimPort, saveFile: saveB, nodeId: 'peer-b', peering: urlA, ...paths(dir, 'peer-b') });
    }

    const converged = await waitFor(
      async () => {
        const [ia, ib] = await Promise.all([identity(portA), identity(portB)]);
        assert.equal(ia.syncFault, null);
        assert.equal(ib.syncFault, null);
        return ia.events === ib.events && ia.term === ib.term && ia.stateHash === ib.stateHash
          ? { ia, ib }
          : null;
      },
      { timeoutMs: 20_000, detail: dump }
    );

    const survivor = victimIsA ? converged.ib : converged.ia;
    const returned = victimIsA ? converged.ia : converged.ib;

    assert.equal(returned.authorityId, survivorId);
    assert.equal(returned.role, 'follower', '回归的旧权威不应重新夺权');
    assert.equal(returned.canWrite, false);
    assert.equal(survivor.authorityId, survivorId);
    assert.equal(survivor.canWrite, true);
    assert.equal(survivor.term, taken.term, '回归不应改变任期');

    // 5. 再跑一会儿，两边仍然逐字节一致。
    const later = await waitFor(
      async () => {
        const [ia, ib] = await Promise.all([identity(portA), identity(portB)]);
        return ia.tick > converged.ia.tick &&
          ia.events === ib.events &&
          ia.term === ib.term &&
          ia.stateHash === ib.stateHash
          ? { ia, ib }
          : null;
      },
      { timeoutMs: 10_000, detail: dump }
    );
    assert.equal(later.ia.syncFault, null);
    assert.equal(later.ib.syncFault, null);
    assert.equal(later.ia.stateHash, later.ib.stateHash);
    if (process.env.PEER_DEBUG === '1') console.log(dump());
  } catch (err) {
    err.message += `\n${dump()}`;
    throw err;
  }
});

test('旧权威的存档比幸存者更新时，按更高任期重建并丢弃旧尾巴', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-island-adopt-'));
  const portA = await freePort();
  const portB = await freePort();
  const urlA = `http://127.0.0.1:${portA}`;
  const urlB = `http://127.0.0.1:${portB}`;
  const saveA = path.join(dir, 'peer-a.json');
  const saveB = path.join(dir, 'peer-b.json');

  // B 拉得很慢，制造“A 的存档比 B 的日志新”的局面。
  const procs = {
    a: launch({ port: portA, saveFile: saveA, nodeId: 'peer-a', peering: urlB, syncIntervalMs: 100, ...paths(dir, 'peer-a') }),
    b: launch({ port: portB, saveFile: saveB, nodeId: 'peer-b', peering: urlA, syncIntervalMs: 2500, ...paths(dir, 'peer-b') }),
  };
  t.after(async () => {
    await stop(procs.a);
    await stop(procs.b);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const dump = () => `peer-a:\n${procs.a.testOutput()}\npeer-b:\n${procs.b.testOutput()}`;

  try {
    await waitFor(
      async () => {
        const [ia, ib] = await Promise.all([identity(portA), identity(portB)]);
        return ia.authorityId === 'peer-a' && ia.canWrite && ib.events > 0 ? { ia, ib } : null;
      },
      { timeoutMs: 20_000, detail: dump }
    );

    // 等 A 明显领先 B 再杀掉 A，保证重启时 A 的存档更新。
    await waitFor(
      async () => {
        const [ia, ib] = await Promise.all([identity(portA), identity(portB)]);
        return ia.events - ib.events >= 3 ? { ia, ib } : null;
      },
      { timeoutMs: 10_000, detail: dump }
    );

    await stop(procs.a);

    const taken = await waitFor(
      async () => {
        const b = await identity(portB);
        assert.equal(b.syncFault, null);
        return b.authorityId === 'peer-b' && b.canWrite ? b : null;
      },
      { timeoutMs: 20_000, detail: dump }
    );

    // 把 A 带着领先的存档重新拉起来：它必须放弃旧尾巴，跟上更高任期。
    procs.a = launch({ port: portA, saveFile: saveA, nodeId: 'peer-a', peering: urlB, syncIntervalMs: 100, ...paths(dir, 'peer-a') });

    const converged = await waitFor(
      async () => {
        const [ia, ib] = await Promise.all([identity(portA), identity(portB)]);
        assert.equal(ia.syncFault, null);
        assert.equal(ib.syncFault, null);
        return ia.events === ib.events && ia.term === ib.term && ia.stateHash === ib.stateHash
          ? { ia, ib }
          : null;
      },
      { timeoutMs: 20_000, detail: dump }
    );

    assert.ok(
      procs.a.testOutput().includes('的日志为准重建'),
      'A 应当以更高任期重建，而不是等待自己的旧尾巴被接受'
    );
    assert.equal(converged.ia.authorityId, 'peer-b');
    assert.equal(converged.ia.canWrite, false);
    assert.equal(converged.ib.term, taken.term);
  } catch (err) {
    err.message += `\n${dump()}`;
    throw err;
  }
});
