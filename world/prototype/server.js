// server.js — 零依赖本地守护进程 + 网页看板。
// B 阶段当前只支持单主 → 镜像的 HTTP 日志同步，暂不做 P2P / 双主排序。

import http from 'node:http';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createWorld,
  snapshot,
  serializeWorld,
  loadWorld,
  deliverLetter,
  letterCooldownLeft,
  MS_PER_TICK,
} from './engine.js';
import { advanceOffline, stepWorld } from './persistence.js';
import { narrate, defaultNarrator, daySummaries } from './chronicle.js';
import { requestLLM } from './brain.js';
import { exportJournal, verifyJournal, applyChunk, eventsHash, stateHash } from './sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4173);
const SAVE = process.env.SAVE_FILE
  ? path.resolve(process.env.SAVE_FILE)
  : path.join(__dirname, 'world-save.json');
const SEED = Number(process.env.SEED) || 20261102;
const NODE_ID = String(process.env.NODE_ID || `node-${PORT}`).slice(0, 32);
const MIRROR = process.env.MIRROR === '1';
const SYNC_MODE = MIRROR ? 'mirror' : String(process.env.SYNC_MODE || 'standalone');
const PEER = SYNC_MODE === 'peer';
const SYNC_TOKEN = String(process.env.SYNC_TOKEN || '');
const PEER_URL = String(process.env.PEER_URL || '').replace(/\/+$/, '');
const PEERS = String(process.env.PEERS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const NODE_NAMES = String(process.env.NODES || NODE_ID)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (!NODE_NAMES.includes(NODE_ID)) NODE_NAMES.push(NODE_ID);
const NODES = [...new Set(NODE_NAMES)].sort();
const TERM_EVENTS = Math.max(10, Number(process.env.TERM_EVENTS) || 200);
const HANDOFF_SETTLE_MS = Math.max(0, Number(process.env.HANDOFF_SETTLE_MS) || 500);
const SYNC_INTERVAL_MS = Math.max(100, Number(process.env.SYNC_INTERVAL_MS) || 2000);
const SAVE_INTERVAL_MS = Math.max(500, Number(process.env.SAVE_INTERVAL_MS) || 10_000);
const SPEED = Math.max(1, Math.min(8, Number(process.env.SPEED) || 1));

function loadOrCreate() {
  if (!fs.existsSync(SAVE)) return createWorld(SEED);
  try {
    const data = JSON.parse(fs.readFileSync(SAVE, 'utf8'));
    const loaded = loadWorld(data.world);
    const elapsed = Math.max(0, Date.now() - (Number(data.savedAt) || Date.now()));
    if (MIRROR || PEER) {
      loaded.returnSummary = null;
      console.log(`  从存档恢复：第 ${loaded.day} 天 · 等待同步`);
    } else {
      loaded.returnSummary = advanceOffline(loaded, elapsed);
      console.log(`  从存档恢复：第 ${loaded.day} 天 · 离线推进 ${loaded.returnSummary.ticks} tick`);
    }
    return loaded;
  } catch (err) {
    console.error(`  存档读取失败，重新开始：${err.message}`);
    return createWorld(SEED);
  }
}

let world = loadOrCreate();
world.config.speed = SPEED;
const clients = new Set();

let lastSyncAt = 0;
let lastSyncError = '';
let lastSyncedTick = -1;
let syncing = false;
let syncFault = '';
let handoffReady = false;
let handoffStart = 0;

// 轮值日志权威：term 由已产生的事件数决定，所有节点从同一条日志算出同一个排序。
function currentTerm(seq = world.nextSeq) {
  return Math.floor(Math.max(0, seq - 1) / TERM_EVENTS);
}

function authorityFor(term = currentTerm()) {
  if (!PEER) return NODE_ID;
  return NODES[((term % NODES.length) + NODES.length) % NODES.length];
}

function isAuthority() {
  return !PEER || authorityFor() === NODE_ID;
}

function canWriteLocally() {
  if (MIRROR) return false;
  if (!PEER) return true;
  return isAuthority() && handoffReady && !syncFault;
}

function canAdvance() {
  if (MIRROR) return false;
  if (world.config.paused) return false;
  if (!PEER) return true;
  return !syncFault && isAuthority() && handoffReady;
}

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

// 观看者自己的模型写这段编年史。事实由引擎给，模型只负责叙述。
async function llmNarrator(context) {
  const lines = context.facts.map((f) => {
    const who = f.people.map((p) => p.name).filter(Boolean).join('、');
    const where = f.place ? `，地点：${f.place}` : '';
    return `[${f.day}日 ${f.clock}] ${f.text}${who ? `（涉及：${who}${where}）` : where}`;
  });
  const sys =
    '你是一位观看者，正在读一座岛上的编年史。只根据给出的事实写一段简洁的中文叙事，' +
    '不要编造事实之外的事，不要写分析、结论或标题。第三人称，克制，有画面感。不超过 400 字。';
  const viewerLine =
    context.viewer.kind === 'resident'
      ? `观看者：${context.viewer.name}（岛上的居民，身份：${context.viewer.identity || '还没有脱变'}）`
      : `观看者：${context.viewer.name}`;
  const user = `${viewerLine}
时间范围：第 ${context.range.fromDay} 天到第 ${context.range.toDay} 天
事实：
${lines.join('\n') || '（这段时间没有关键事件）'}

请写一段叙事。`;

  world.llmCalls = (world.llmCalls || 0) + 1;
  const text = await requestLLM(world, sys, user, 700);
  if (!String(text || '').trim()) throw new Error('LLM 返回了空叙事');
  return text;
}

async function handleApi(req, res, url) {
  const body = await readBody(req);

  if (url.pathname === '/api/pause') {
    if (!canWriteLocally()) return json(res, { ok: false, error: 'this node is read-only right now' }, 403);
    world.config.paused = !!body.paused;
    return json(res, { ok: true, paused: world.config.paused });
  }

  if (url.pathname === '/api/speed') {
    if (!canWriteLocally()) return json(res, { ok: false, error: 'this node is read-only right now' }, 403);
    const s = Math.max(1, Math.min(8, Number(body.speed) || 1));
    world.config.speed = s;
    return json(res, { ok: true, speed: s });
  }

  if (url.pathname === '/api/whisper') {
    if (!canWriteLocally()) return json(res, { ok: false, error: 'this node is read-only right now' }, 403);
    const a = world.agents.find((x) => x.id === body.agentId);
    if (!a) return json(res, { ok: false, error: 'no such agent' }, 404);
    const cooldown = letterCooldownLeft(world, a);
    if (cooldown > 0) {
      return json(res, { ok: false, error: 'cooldown', cooldownLeft: cooldown }, 429);
    }
    const text = String(body.text || '').slice(0, 160).trim();
    if (!text) return json(res, { ok: false, error: 'empty' }, 400);
    const heard = deliverLetter(world, a, text);
    return json(res, { ok: true, heard, cooldownLeft: letterCooldownLeft(world, a) });
  }

  if (url.pathname === '/api/timeline') {
    return json(res, { currentDay: world.day || 1, days: daySummaries(world) });
  }

  // B 阶段地基：导出可交换的日志信封。
  if (url.pathname === '/api/journal') {
    const fromSeq = Math.max(1, Math.floor(Number(url.searchParams.get('fromSeq')) || 1));
    const nodeId = String(url.searchParams.get('nodeId') || NODE_ID).slice(0, 32);
    const epoch = Math.max(1, Math.floor(Number(url.searchParams.get('epoch')) || 1));
    return json(res, exportJournal(world, { fromSeq, nodeId, epoch }));
  }

  // 身份与当前状态哈希：两台机器互相对账用。
  if (url.pathname === '/api/identity') {
    return json(res, {
      nodeId: NODE_ID,
      seed: world.seed,
      tick: world.tick,
      day: world.day || 1,
      clock: world.clock || '08:00',
      events: world.nextSeq - 1,
      journalHash: exportJournal(world).eventsHash,
      stateHash: stateHash(world),
      mode: SYNC_MODE,
      mirror: MIRROR,
      peer: PEER_URL || null,
      peers: PEERS,
      role: PEER ? (isAuthority() ? 'authority' : 'follower') : MIRROR ? 'mirror' : 'standalone',
      term: PEER ? currentTerm() : null,
      termEvents: PEER ? TERM_EVENTS : null,
      nodes: PEER ? NODES : [],
      authorityId: PEER ? authorityFor() : null,
      handoffReady: PEER ? handoffReady : null,
      syncFault: syncFault || null,
      canWrite: canWriteLocally(),
      lastSyncAt: lastSyncAt || null,
      lastSyncedTick,
      lastSyncError,
    });
  }

  // 手动存档：两机演示和断线重连前先落一次盘。
  if (url.pathname === '/api/save') {
    saveWorld();
    return json(res, { ok: true, savedAt: Date.now(), tick: world.tick, stateHash: stateHash(world) });
  }

  // 接收日志块：镜像模式用于演示推送，peer 模式用于手动/测试导入。
  if (url.pathname === '/api/journal/apply') {
    if (!MIRROR && !PEER) {
      return json(res, { ok: false, error: 'journal apply is disabled on standalone nodes' }, 403);
    }
    if (!SYNC_TOKEN) {
      return json(res, { ok: false, error: 'SYNC_TOKEN is required for journal apply' }, 503);
    }
    const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const expected = Buffer.from(SYNC_TOKEN);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return json(res, { ok: false, error: 'unauthorized' }, 401);
    }
    const result = applyChunk(world, body);
    if (!result.ok) return json(res, { ok: false, ...result }, 400);
    if (!result.matched) {
      if (PEER) syncFault = 'state hash mismatch';
      return json(
        res,
        { ok: false, error: 'state hash mismatch', local: stateHash(result.world), claimed: body.stateHash },
        409
      );
    }
    world = result.world;
    lastSyncAt = Date.now();
    lastSyncedTick = world.tick;
    lastSyncError = '';
    if (PEER) {
      // 收到别人的日志后，先重新交接，再决定能不能写。
      handoffReady = false;
      handoffStart = 0;
    }
    return json(res, {
      ok: true,
      tick: world.tick,
      day: world.day || 1,
      events: world.nextSeq - 1,
      stateHash: stateHash(world),
    });
  }

  // 校验一份别人发来的日志，并说明它是否正好覆盖本地当前的头部。
  if (url.pathname === '/api/journal/verify') {
    const check = verifyJournal(body);
    if (!check.ok) return json(res, { ok: false, ...check }, 400);
    const seedMatch = body.seed === world.seed;
    const covers = body.fromSeq <= 1 && body.toTick === world.tick;
    const localStateHash = stateHash(world);
    return json(res, {
      ok: true,
      verified: true,
      seedMatch,
      coversLocalHead: covers,
      localStateHash,
      journalStateHash: body.stateHash,
      matched: seedMatch && covers ? localStateHash === body.stateHash : null,
    });
  }

  if (url.pathname === '/api/chronicle') {
    const viewerId = String(body.viewerId || '').slice(0, 64) || null;
    const fromDay = Math.max(1, Math.floor(Number(body.fromDay) || 1));
    const toDay = Math.max(fromDay, Math.floor(Number(body.toDay) || fromDay));
    const range = { fromDay, toDay };

    if (!world.api.key) {
      const result = await narrate(world, viewerId, range, defaultNarrator);
      return json(res, { ok: true, ...result, model: false, fallback: false });
    }

    try {
      const result = await narrate(world, viewerId, range, llmNarrator);
      return json(res, { ok: true, ...result, model: true, fallback: false });
    } catch (err) {
      world.llmErrors = (world.llmErrors || 0) + 1;
      world.llmLastError = String(err?.message || err);
      const result = await narrate(world, viewerId, range, defaultNarrator, { cache: false });
      return json(res, { ok: true, ...result, model: true, fallback: true });
    }
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

async function syncPeer() {
  if (PEER || MIRROR || !PEER_URL || !SYNC_TOKEN || world.inflight > 0) return;

  try {
    const identityResponse = await fetch(`${PEER_URL}/api/identity`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!identityResponse.ok) throw new Error(`peer identity HTTP ${identityResponse.status}`);
    const identity = await identityResponse.json();
    if (identity.seed !== world.seed) throw new Error('peer seed mismatch');

    const fromSeq = Math.max(1, Math.floor(Number(identity.events) || 0) + 1);
    if (fromSeq > world.nextSeq) throw new Error('peer is ahead of leader');

    const prefix = world.eventLog.filter((e) => e.seq < fromSeq);
    const prefixHash = eventsHash(prefix);
    if (identity.events > 0 && identity.journalHash !== prefixHash) {
      throw new Error('peer journal diverged before current head');
    }

    const chunk = exportJournal(world, {
      fromSeq,
      prevHash: fromSeq > 1 ? prefixHash : null,
      nodeId: NODE_ID,
    });
    if (!chunk.ready) return;

    const response = await fetch(`${PEER_URL}/api/journal/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SYNC_TOKEN}`,
      },
      body: JSON.stringify(chunk),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error || `peer apply HTTP ${response.status}`);
    }

    lastSyncAt = Date.now();
    lastSyncedTick = result.tick;
    lastSyncError = '';
  } catch (err) {
    lastSyncError = String(err?.message || err);
  }
}

// peer 模式：每个节点都从对端拉缺失日志。谁拉谁都不改变“日志是权威”这条。
async function pullFromPeer(peer) {
  const identityResponse = await fetch(`${peer}/api/identity`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!identityResponse.ok) throw new Error(`peer identity HTTP ${identityResponse.status}`);
  const identity = await identityResponse.json();
  if (identity.seed !== world.seed) throw new Error('conflict: peer seed mismatch');

  const localHead = world.nextSeq - 1;
  if (identity.events < localHead) return { behind: true };

  if (identity.events === localHead) {
    // 头部相同却没有同一个状态，说明已经分叉，必须停下来。
    if (identity.tick === world.tick && identity.stateHash !== stateHash(world)) {
      throw new Error('conflict: same head but state hash differs');
    }
    return { noop: true };
  }

  const journalResponse = await fetch(
    `${peer}/api/journal?fromSeq=${world.nextSeq}&nodeId=${encodeURIComponent(NODE_ID)}`,
    { signal: AbortSignal.timeout(10_000) }
  );
  if (!journalResponse.ok) throw new Error(`peer journal HTTP ${journalResponse.status}`);
  const chunk = await journalResponse.json();
  if (!chunk.events?.length) return { noop: true };

  const result = applyChunk(world, chunk);
  if (!result.ok) {
    if (result.reason === 'stale chunk') return { stale: true };
    throw new Error(`conflict: ${result.reason}`);
  }
  if (!result.matched) throw new Error('conflict: state hash mismatch');

  world = result.world;
  lastSyncAt = Date.now();
  lastSyncedTick = world.tick;
  lastSyncError = '';
  return { applied: true, tick: world.tick };
}

async function syncPeers() {
  if (!PEER || syncing || world.inflight > 0) return;
  syncing = true;

  let allOk = true;
  let firstError = '';
  for (const peer of PEERS) {
    try {
      await pullFromPeer(peer);
    } catch (err) {
      allOk = false;
      const message = String(err?.message || err);
      if (!firstError) firstError = message;
      if (message.startsWith('conflict:')) syncFault = message;
    }
  }

  lastSyncError = firstError;

  if (!PEER) {
    syncing = false;
    return;
  }

  if (!isAuthority()) {
    handoffReady = false;
    handoffStart = 0;
  } else if (syncFault) {
    handoffReady = false;
  } else {
    if (!handoffStart) handoffStart = Date.now();
    if (allOk && Date.now() - handoffStart >= HANDOFF_SETTLE_MS) handoffReady = true;
  }

  syncing = false;
}

// 24 倍：1 现实小时 = 1 世界日。按真实经过时间累积 tick，和离线推进同一把尺子。
let lastTickAt = Date.now();
let tickCarry = 0;
setInterval(() => {
  const now = Date.now();
  const elapsed = now - lastTickAt;
  lastTickAt = now;
  if (canAdvance()) {
    const speed = Math.max(1, world.config.speed | 0);
    tickCarry += elapsed * speed;
    while (tickCarry >= MS_PER_TICK) {
      stepWorld(world, 1);
      tickCarry -= MS_PER_TICK;
      if (!canAdvance()) {
        // 任期内事件数已经跨过边界，或节点失去权威，交给下一个节点。
        tickCarry = 0;
        break;
      }
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

setInterval(saveWorld, SAVE_INTERVAL_MS).unref();
if (PEER) setInterval(syncPeers, SYNC_INTERVAL_MS).unref();
else if (PEER_URL && !MIRROR) setInterval(syncPeer, SYNC_INTERVAL_MS).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    saveWorld();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`\n  最后的岛 · ${PEER ? '全节点' : MIRROR ? '镜像节点' : '独立节点'}`);
  console.log(`  ${NODE_ID} · seed ${world.seed} · http://localhost:${PORT}`);
  if (PEER) {
    console.log(
      `  peer 模式 · 节点 ${NODES.join(', ')} · 每 ${TERM_EVENTS} 条事件轮换 · 当前第 ${currentTerm()} 任：${authorityFor()}`
    );
    console.log(`  对端：${PEERS.length ? PEERS.join(', ') : '（无，单节点）'}`);
    if (!SYNC_TOKEN) console.warn('  警告：未配置 SYNC_TOKEN，其他节点无法向本节点写入日志。');
    syncPeers();
  } else if (PEER_URL && !MIRROR) {
    console.log(`  同步目标：${PEER_URL} · 每 ${SYNC_INTERVAL_MS} ms 轮询`);
    syncPeer();
  }
  if (MIRROR && !SYNC_TOKEN) {
    console.error('  警告：镜像节点未配置 SYNC_TOKEN，拒绝日志写入。');
  }
  console.log('');
});
