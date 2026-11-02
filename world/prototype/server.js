// server.js — 零依赖本地守护进程 + 网页看板。
// 这一版还没有 P2P：先让世界在一个进程里跑起来，验证好不好看。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld, snapshot, serializeWorld, loadWorld, logEvent, remember, MS_PER_TICK } from './engine.js';
import { advanceOffline, stepWorld } from './persistence.js';

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

function applyApiConfig(source) {
  world.api.provider = source.provider === 'anthropic' ? 'anthropic' : 'openai';
  world.api.base = String(source.base || '').trim();
  world.api.key = String(source.key || '').trim();
  world.api.model = String(source.model || '').trim();
  const raw = source.llmAgents === undefined ? world.agents.length : Number(source.llmAgents);
  const count = Math.max(0, Math.min(world.agents.length, Number.isFinite(raw) ? raw : world.agents.length));
  world.config.llmAgents = count;
  world.agents.forEach((a, i) => {
    a.useLLM = !!world.api.key && i < count;
  });
}

if (process.env.LLM_BASE) {
  applyApiConfig({
    provider: process.env.LLM_PROVIDER,
    base: process.env.LLM_BASE,
    key: process.env.LLM_KEY,
    model: process.env.LLM_MODEL,
    llmAgents: process.env.LLM_AGENTS,
  });
  console.log(`  LLM: ${world.api.provider} · ${world.api.model} · ${world.config.llmAgents} 人`);
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
    remember(a, `你听见一个声音说：「${text}」`);
    logEvent(world, 'letter', `一个声音在${a.name}耳边说：「${text}」`, a.id, { text });
    return json(res, { ok: true });
  }

  if (url.pathname === '/api/config') {
    applyApiConfig(body);
    return json(res, { ok: true, configured: !!world.api.key, llmAgents: world.config.llmAgents });
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

// 24 倍：1 现实小时 = 1 世界日。按真实经过时间累积 tick，和离线推进同一把尺子。
let lastTickAt = Date.now();
let tickCarry = 0;
setInterval(() => {
  const now = Date.now();
  const elapsed = now - lastTickAt;
  lastTickAt = now;
  if (!world.config.paused) {
    const speed = Math.max(1, world.config.speed | 0);
    tickCarry += elapsed * speed;
    while (tickCarry >= MS_PER_TICK) {
      stepWorld(world, 1);
      tickCarry -= MS_PER_TICK;
    }
  } else {
    tickCarry = 0;
  }
  broadcast();
}, 250);

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
