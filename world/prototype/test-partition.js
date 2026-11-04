// test-partition.js — 网络分区演练：不杀进程，只切断两个节点之间的连线。
//
// 用两个本地 TCP 代理夹在节点中间，cut 掉代理就等于断网：
//   peer-a --代理A--> peer-b
//   peer-a <--代理B-- peer-b
//
// 预期（当前协议）：
//   1. 分区期间旧权威听不到任何人，继续在旧任期写；另一侧租约到期，
//      写一条更高任期的 term 事件后接管，两边同时持有写入权——真正的分裂。
//   2. 愈合后以更高任期为准：旧权威丢弃分区期间那段没人接受的尾巴（这是
//      有损的，必须能被观察/人工确认），更高任期一侧若看到分叉则停写。
//   3. /api/sync/adopt 能把停写的一侧拉回同一个日志，之后世界继续前进。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net, { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const SERVER = path.join(import.meta.dirname, 'server.js');
const TOKEN = 'partition-test-token-0123456789';
const SEED = '616161';
const TERM_EVENTS = '100000'; // 只允许租约触发接管，排除正常轮换

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

// 一个可以随时“断网/恢复”的 TCP 代理。
async function startProxy(targetPort) {
  const state = { cut: false, pairs: new Set() };
  const server = net.createServer((client) => {
    if (state.cut) {
      client.destroy();
      return;
    }
    const upstream = net.connect(targetPort, '127.0.0.1');
    const pair = { client, upstream };
    state.pairs.add(pair);
    client.pipe(upstream);
    upstream.pipe(client);
    const close = () => {
      state.pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close);
    client.on('close', close);
    upstream.on('error', close);
    upstream.on('close', close);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    cut() {
      state.cut = true;
      for (const pair of state.pairs) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
      state.pairs.clear();
    },
    heal() {
      state.cut = false;
    },
    close() {
      return new Promise((resolve) => {
        for (const pair of state.pairs) {
          pair.client.destroy();
          pair.upstream.destroy();
        }
        state.pairs.clear();
        server.close(() => resolve());
      });
    },
  };
}

function launch({ port, dir, nodeId, peering }) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      SEED,
      NODE_ID: nodeId,
      SAVE_FILE: path.join(dir, `${nodeId}.json`),
      NODE_KEY_FILE: path.join(dir, `key-${nodeId}.json`),
      TRUST_FILE: path.join(dir, `trust-${nodeId}.json`),
      SYNC_MODE: 'peer',
      NODES: 'peer-a,peer-b',
      PEERS: peering,
      TERM_EVENTS,
      SYNC_INTERVAL_MS: '100',
      HANDOFF_SETTLE_MS: '200',
      LEASE_MS: '700',
      TAKEOVER_MS: '1400',
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

async function adopt(port, peerUrl) {
  const res = await fetch(`http://127.0.0.1:${port}/api/sync/adopt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ peer: peerUrl }),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: await res.json() };
}

test('断网后两边同时写入，愈合后以更高任期为准，并可由人工恢复', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-island-partition-'));
  const portA = await freePort();
  const portB = await freePort();
  const proxyToB = await startProxy(portB); // peer-a 通过它访问 peer-b
  const proxyToA = await startProxy(portA); // peer-b 通过它访问 peer-a

  const a = launch({ port: portA, dir, nodeId: 'peer-a', peering: proxyToB.url });
  const b = launch({ port: portB, dir, nodeId: 'peer-b', peering: proxyToA.url });
  t.after(async () => {
    await stop(a);
    await stop(b);
    await proxyToB.close();
    await proxyToA.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const dump = () => `peer-a:\n${a.testOutput()}\npeer-b:\n${b.testOutput()}`;

  try {
    // 1. 正常收敛，确定当前权威。
    const ready = await waitFor(
      async () => {
        const [ia, ib] = await Promise.all([identity(portA), identity(portB)]);
        return ia.events === ib.events &&
          ia.stateHash === ib.stateHash &&
          (ia.canWrite || ib.canWrite)
          ? { ia, ib }
          : null;
      },
      { detail: dump }
    );
    assert.equal(ready.ia.syncFault, null);
    assert.equal(ready.ib.syncFault, null);
    const oldAuthorityIsA = ready.ia.canWrite;
    const oldAuthority = oldAuthorityIsA ? ready.ia : ready.ib;
    const survivorId = oldAuthorityIsA ? 'peer-b' : 'peer-a';
    const survivorPort = oldAuthorityIsA ? portB : portA;
    const oldAuthorityPort = oldAuthorityIsA ? portA : portB;

    // 2. 切断两条连线。不杀进程。
    proxyToB.cut();
    proxyToA.cut();

    // 3. 两边都以为自己能写：旧权威留在旧任期，另一侧租约到期后接管。
    const split = await waitFor(
      async () => {
        const [ia, ib] = await Promise.all([identity(portA), identity(portB)]);
        return ia.canWrite && ib.canWrite && ia.term !== ib.term ? { ia, ib } : null;
      },
      { timeoutMs: 20_000, detail: dump }
    );
    const oldSide = oldAuthorityIsA ? split.ia : split.ib;
    const newSide = oldAuthorityIsA ? split.ib : split.ia;
    assert.equal(oldSide.term, oldAuthority.term, '旧权威应当留在旧任期');
    assert.ok(newSide.term > oldSide.term, '接管方应当有更高任期');

    // 4. 让两边各写一段，留下真正的同前缀分叉。
    const diverged = await waitFor(
      async () => {
        const [ia, ib] = await Promise.all([identity(portA), identity(portB)]);
        return ia.events >= split.ia.events + 4 && ib.events >= split.ib.events + 4
          ? { ia, ib }
          : null;
      },
      { timeoutMs: 15_000, detail: dump }
    );
    assert.notEqual(diverged.ia.stateHash, diverged.ib.stateHash, '分区期间两边状态应当分叉');
    const oldWrote = oldAuthorityIsA ? diverged.ia.events : diverged.ib.events;
    const newWrote = oldAuthorityIsA ? diverged.ib.events : diverged.ia.events;
    assert.ok(oldWrote > oldSide.events, '旧权威在分区期间应当继续写');
    assert.ok(newWrote > newSide.events, '接管方在分区期间应当继续写');

    // 5. 愈合。以更高任期为准。
    proxyToB.heal();
    proxyToA.heal();

    // 给两边几个同步周期，让“采纳 / 停写”都发生。
    await delay(3000);
    const [healedA, healedB] = await Promise.all([identity(portA), identity(portB)]);
    const healed = {
      ia: healedA,
      ib: healedB,
      high: healedA.term >= healedB.term ? healedA : healedB,
      low: healedA.term >= healedB.term ? healedB : healedA,
    };
    if (process.env.PEER_DEBUG === '1') {
      console.log(`after heal:\n${JSON.stringify({ ia: healedA, ib: healedB }, null, 2)}`);
    }

    // 旧权威分区期间写的事件不可能被保留。自动采纳时必须记录丢弃条数；
    // 如果本进程启动后写过事件，则应当拒绝静默丢弃，留下分区停写标记。
    const adoption = healed.low.lastAdoption || healed.high.lastAdoption;
    const partitionFault = [healed.ia, healed.ib].some((x) =>
      /partition:/.test(x.syncFault || '')
    );
    assert.ok(adoption || partitionFault, '分区愈合后应当留下丢弃记录或分区停写标记');
    if (adoption) assert.ok(adoption.dropped > 0, '如果自动采纳，必须记录丢弃条数');
    assert.ok(
      healed.ia.syncFault || healed.ib.syncFault,
      '分区愈合后应当至少有一侧停写并等待人工确认'
    );

    // 6. 人工恢复：先让旧权威采纳更高任期，再让停写的一侧对齐。
    const faultedPort = healed.ia.syncFault ? portA : healed.ib.syncFault ? portB : null;
    const faultedPeer = healed.ia.syncFault ? proxyToB.url : proxyToA.url;
    if (faultedPort) {
      const result = await adopt(faultedPort, faultedPeer);
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }

    // 另一侧可能也停写了；两边都尝试一次 adopt，幂等。
    for (const [port, peerUrl] of [
      [portA, proxyToB.url],
      [portB, proxyToA.url],
    ]) {
      const current = await identity(port);
      if (current.syncFault) {
        const result = await adopt(port, peerUrl);
        assert.equal(result.status, 200, JSON.stringify(result.body));
      }
    }

    const recovered = await waitFor(
      async () => {
        const [ia, ib] = await Promise.all([identity(portA), identity(portB)]);
        return !ia.syncFault &&
          !ib.syncFault &&
          ia.events === ib.events &&
          ia.term === ib.term &&
          ia.stateHash === ib.stateHash
          ? { ia, ib }
          : null;
      },
      { timeoutMs: 25_000, detail: dump }
    );

    // 7. 恢复后世界继续前进。
    const after = await waitFor(
      async () => {
        const [ia, ib] = await Promise.all([identity(portA), identity(portB)]);
        return ia.events > recovered.ia.events && ib.events > recovered.ib.events ? { ia, ib } : null;
      },
      { timeoutMs: 15_000, detail: dump }
    );
    assert.equal(after.ia.stateHash, after.ib.stateHash);
    assert.equal(after.ia.term, after.ib.term);
    assert.ok(
      after.ia.authorityId === 'peer-a' || after.ia.authorityId === 'peer-b',
      '恢复后仍应有明确的写入者'
    );
    if (process.env.PEER_DEBUG === '1') console.log(dump());
  } catch (err) {
    err.message += `\n${dump()}`;
    throw err;
  }
});
