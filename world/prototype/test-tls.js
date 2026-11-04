// test-tls.js — 两个 HTTPS 全节点：签名身份 + TLS 传输端到端收敛。
//
// 证书在测试启动时用 openssl 生成（临时目录，不提交私钥）。
// 节点之间用 NODE_EXTRA_CA_CERTS 信任这张自签证书；本测试进程为了直接
// 访问自签地址关闭了证书校验（只影响测试进程，不影响两个节点）。
// 机器上没有 openssl 时跳过。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyEnvelopeSignature, verifyIdentityDocument } from './identity.js';

const SERVER = path.join(import.meta.dirname, 'server.js');
const TOKEN = 'tls-test-token-0123456789';
const SEED = '818181';

const hasOpenSSL = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;

// 仅测试进程：直接访问自签证书的地址。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

function makeCert(dir) {
  const key = path.join(dir, 'tls-key.pem');
  const cert = path.join(dir, 'tls-cert.pem');
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { stdio: 'ignore' }
  );
  if (result.status !== 0 || !fs.existsSync(key) || !fs.existsSync(cert)) {
    throw new Error('openssl 生成测试证书失败');
  }
  return { key, cert };
}

function launch({ port, dir, nodeId, peering, certs }) {
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
      TERM_EVENTS: '60',
      SYNC_INTERVAL_MS: '100',
      HANDOFF_SETTLE_MS: '300',
      SAVE_INTERVAL_MS: '1000',
      SPEED: '8',
      SYNC_TOKEN: TOKEN,
      TLS_KEY_FILE: certs.key,
      TLS_CERT_FILE: certs.cert,
      NODE_EXTRA_CA_CERTS: certs.cert,
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
  const res = await fetch(`https://127.0.0.1:${port}/api/identity`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`identity HTTP ${res.status}`);
  return res.json();
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

test(
  '两个 HTTPS 节点通过签名身份收敛',
  { skip: hasOpenSSL ? false : '没有 openssl，跳过 TLS 测试' },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-island-tls-'));
    const certs = makeCert(dir);
    const portA = await freePort();
    const portB = await freePort();
    const urlA = `https://127.0.0.1:${portA}`;
    const urlB = `https://127.0.0.1:${portB}`;

    const a = launch({ port: portA, dir, nodeId: 'peer-a', peering: urlB, certs });
    const b = launch({ port: portB, dir, nodeId: 'peer-b', peering: urlA, certs });
    t.after(async () => {
      await stop(a);
      await stop(b);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const dump = () => `peer-a:\n${a.testOutput()}\npeer-b:\n${b.testOutput()}`;

    try {
      const converged = await waitFor(
        async () => {
          const [ia, ib] = await Promise.all([identity(portA), identity(portB)]);
          return ia.events === ib.events &&
            ia.stateHash === ib.stateHash &&
            ia.term === ib.term &&
            (ia.canWrite || ib.canWrite)
            ? { ia, ib }
            : null;
        },
        { detail: dump }
      );

      assert.equal(converged.ia.seed, converged.ib.seed);
      assert.equal(converged.ia.stateHash, converged.ib.stateHash);
      assert.equal(converged.ia.journalHash, converged.ib.journalHash);
      assert.equal(converged.ia.syncFault, null);
      assert.equal(converged.ib.syncFault, null);

      // 身份自证与日志来源签名在 HTTPS 链路上同样成立。
      assert.equal(verifyIdentityDocument(converged.ia), true);
      assert.equal(verifyIdentityDocument(converged.ib), true);
      const journal = await (await fetch(`${urlA}/api/journal?fromSeq=1`)).json();
      assert.equal(
        verifyEnvelopeSignature(journal, converged.ia.publicKey, {
          nodeId: converged.ia.nodeId,
        }),
        true
      );

      // 两边已经通过 TLS 拉过对方身份，信任表里应当有对方。
      assert.ok(
        converged.ia.trustedPeers.some((p) => p.nodeId === 'peer-b'),
        'peer-a 应当固定 peer-b 的公钥'
      );
      assert.ok(
        converged.ib.trustedPeers.some((p) => p.nodeId === 'peer-a'),
        'peer-b 应当固定 peer-a 的公钥'
      );

      // 启动日志里确实用了 https。
      assert.ok(a.testOutput().includes('https://localhost'), '应当以 HTTPS 监听');
      assert.ok(b.testOutput().includes('https://localhost'), '应当以 HTTPS 监听');
    } catch (err) {
      err.message += `\n${dump()}`;
      throw err;
    }
  }
);
