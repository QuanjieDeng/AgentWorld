// server.js — 零依赖本地守护进程 + 网页看板。
// 这一版还没有 P2P：先让世界在一个进程里跑起来，验证好不好看。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld, tick, snapshot, serializeWorld, loadWorld } from './engine.js';
import { processBrains } from './brain.js';
import { advanceOffline } from './persistence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const SAVE = path.join(__dirname, 'world-save.json');
const PORT = Number(process.env.PORT || 4173);

function loadOrCreate() {
  if (!fs.existsSync(SAVE)) return createWorld();
  try {
    const data = JSON.parse(fs.readFileSync(SAVE, 'utf8'));
    const loaded = loadWorld(data.world);
    const elapsed = Math.max(0, Date.now() - (Number(data.savedAt) || Date.now()));
    loaded.returnSummary = advanceOffline(loaded, elapsed);
    console.log(`  从存档恢复：第 ${loaded.day} 天 · 离线推进 ${loaded.returnSummary.ticks} tick`);
    return loaded;
  } catch (err) {
    console.error(`  存档读取失败，重新开始：${err.message}`);
    return createWorld();
  }
}

const world = loadOrCreate();
const clients = new Set();

if (process.env.LLM_BASE) {
  world.api.base = process.env.LLM_BASE;
  world.api.key = process.env.LLM_KEY || '';
  world.api.model = process.env.LLM_MODEL || '';
  world.api.provider = process.env.LLM_PROVIDER === 'anthropic' ? 'anthropic' : 'openai';
  const raw = process.env.LLM_AGENTS ? Number(process.env.LLM_AGENTS) : world.agents.length;
  const count = Math.max(0, Math.min(world.agents.length, Number.isFinite(raw) ? raw : world.agents.length));
  world.config.llmAgents = count;
  world.agents.forEach((a, i) => {
    a.useLLM = !!world.api.key && i < count;
  });
  console.log(`  LLM: ${world.api.provider} · ${world.api.model} · ${count} 人`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

async function handleApi(req, res, url) {
  const body = await readBody(req);

  if (url.pathname === '/api/pause') {
    world.config.paused = !!body.paused;
    return json(res, { ok: true, paused: world.config.paused });
  }

  if (url.pathname === '/api/speed') {
    const s = Math.max(1, Math.min(8, Number(body.speed) || 1));
    world.config.speed = s;
    return json(res, { ok: true, speed: s });
  }

  if (url.pathname === '/api/whisper') {
    const a = world.agents.find((x) => x.id === body.agentId);
    if (!a) return json(res, { ok: false, error: 'no such agent' }, 404);
    const text = String(body.text || '').slice(0, 160).trim();
    if (!text) return json(res, { ok: false, error: 'empty' }, 400);
    a.letter = text;
    a.memory.push(`你听见一个声音说：「${text}」`);
    if (a.memory.length > 20) a.memory.shift();
    world.log.push({
      t: world.tick,
      day: world.day,
      clock: world.clock,
      type: 'letter',
      text: `一个声音在${a.name}耳边说：「${text}」`,
      agentId: a.id,
    });
    return json(res, { ok: true });
  }

  if (url.pathname === '/api/config') {
    world.api.provider = body.provider === 'anthropic' ? 'anthropic' : 'openai';
    world.api.base = String(body.base || '').trim();
    world.api.key = String(body.key || '').trim();
    world.api.model = String(body.model || '').trim();
    const n = Math.max(0, Math.min(world.agents.length, Number(body.llmAgents) || 0));
    world.config.llmAgents = n;
    world.agents.forEach((a, i) => {
      a.useLLM = !!world.api.key && i < n;
    });
    return json(res, { ok: true, configured: !!world.api.key, llmAgents: n });
  }

  if (url.pathname === '/api/state') {
    return json(res, snapshot(world));
  }

  return json(res, { ok: false }, 404);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify(snapshot(world))}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => json(res, { ok: false, error: String(err) }, 500));
    return;
  }

  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC, decodeURIComponent(rel)));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

function broadcast() {
  const msg = `data: ${JSON.stringify(snapshot(world))}\n\n`;
  for (const c of clients) {
    try {
      c.write(msg);
    } catch {
      clients.delete(c);
    }
  }
}

setInterval(() => {
  if (!world.config.paused) {
    const speed = Math.max(1, world.config.speed | 0);
    for (let i = 0; i < speed; i++) {
      tick(world);
      processBrains(world);
    }
  }
  broadcast();
}, 1000);

function saveWorld() {
  try {
    const payload = JSON.stringify({ savedAt: Date.now(), world: serializeWorld(world) });
    fs.writeFileSync(`${SAVE}.tmp`, payload);
    fs.renameSync(`${SAVE}.tmp`, SAVE);
  } catch (err) {
    console.error(`  存档写入失败：${err.message}`);
  }
}

setInterval(saveWorld, 10_000).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    saveWorld();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`\n  最后的岛 · 垂直切片`);
  console.log(`  http://localhost:${PORT}\n`);
});
