// test-export.js — 编年史导出：每个观看者导出的都是本机这份“我的版本”。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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
      SEED: '646464',
      NODE_ID: 'export-node',
      SAVE_FILE: path.join(dir, 'save.json'),
      NODE_KEY_FILE: path.join(dir, 'key.json'),
      TRUST_FILE: path.join(dir, 'trust.json'),
      REPORT_FILE: path.join(dir, 'reports.json'),
      NARRATIVE_FILE: path.join(dir, 'narratives.json'),
      SYNC_INTERVAL_MS: '200',
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

test('编年史导出返回本机观看者的 Markdown 版本', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-island-export-'));
  const port = await freePort();
  const child = launch({ port, dir });
  t.after(async () => {
    await stop(child);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const dump = () => child.testOutput();

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(
      async () => {
        const res = await fetch(`${base}/api/state`);
        return res.ok ? true : null;
      },
      { detail: dump }
    );

    const page = await fetch(`${base}/public`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /arrivalDialog/);

    // 没有配置模型时，翻译接口原样返回中文。
    const translated = await fetch(`${base}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: ['你好', '世界'], lang: 'en' }),
    });
    const translatedBody = await translated.json();
    assert.equal(translated.status, 200);
    assert.deepEqual(translatedBody.translations, ['你好', '世界']);
    assert.equal(translatedBody.model, false);

    // 时间轴回到第 1 天：日志重放出来的历史快照。
    const history = await (await fetch(`${base}/api/history?day=1`)).json();
    assert.equal(history.history, true);
    assert.equal(history.day, 1);
    assert.equal(history.tick, 480);
    assert.equal(history.agents.length, 12);
    assert.ok(history.map.length > 0);

    const res = await fetch(`${base}/api/chronicle/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerId: 'export-viewer-1', fromDay: 1, toDay: 1 }),
    });
    const data = await res.json();
    assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal(data.ok, true);
    assert.match(data.filename, /^island-chronicle-d1-d1\.md$/);
    assert.match(data.markdown, /# 最后的岛 · 编年史（我的版本）/);
    assert.match(data.markdown, /观看者：export-viewer-1/);
    assert.match(data.markdown, /不是官方历史/);
    assert.match(data.markdown, /第 1 天/);

    // 另一个观看者拿到的是同一段事实、不同缓存键（这里至少不报错）。
    const other = await fetch(`${base}/api/chronicle/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerId: 'export-viewer-2', fromDay: 1, toDay: 2 }),
    });
    const otherData = await other.json();
    assert.equal(other.status, 200, JSON.stringify(otherData));
    assert.match(otherData.markdown, /观看者：export-viewer-2/);

    // 举报只记在本机，供人工查看。
    const state = await (await fetch(`${base}/api/state`)).json();
    const target = state.agents.find((a) => a.alive);
    for (let i = 0; i < 2; i++) {
      const report = await fetch(`${base}/api/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: target.id, reason: '像是真人', viewerId: 'export-viewer-1' }),
      });
      const reportData = await report.json();
      assert.equal(report.status, 200, JSON.stringify(reportData));
      assert.equal(reportData.count, i + 1);
    }
    const reports = await (await fetch(`${base}/api/reports`)).json();
    assert.equal(reports.counts[target.id], 2);
    assert.equal(reports.total, 2);
  } catch (err) {
    err.message += `\n${dump()}`;
    throw err;
  }
});
