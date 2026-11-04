// chronicle.js — 编年史叙事层。
//
// 事实层（eventLog / world.chronicle）永远是权威，这里只读。
// 叙事按「观看者 + 事件段」生成并缓存；缓存挂在 world 对象上，不进存档，
// 所以 A 的版本不会覆盖 B 的，也不会变成官方历史。

import { TICKS_PER_DAY, TILE, W } from './engine.js';

// 只有这些事件值得写进编年史：死亡、脱变、立法、结社、冲突、迁移、收养/继承、淡出。
export const CHRONICLE_EVENT_TYPES = Object.freeze([
  'death',
  'turning',
  'institution',
  'punish',
  'fight',
  'adopt',
  'inherit',
  'settle',
  'bury',
  'fade',
  'collapse',
  'letter',
]);

const KEY_TYPES = new Set(CHRONICLE_EVENT_TYPES);

const CATEGORY = {
  death: 'death',
  bury: 'death',
  turning: 'turning',
  institution: 'institution',
  punish: 'conflict',
  fight: 'conflict',
  collapse: 'conflict',
  adopt: 'kin',
  inherit: 'kin',
  settle: 'migration',
  fade: 'fade',
  letter: 'letter',
};

export function dayOfTick(t) {
  return Math.floor(t / TICKS_PER_DAY) + 1;
}

export function normalizeRange(world, range = {}) {
  let fromDay = Number(range.fromDay) || 1;
  let toDay = Number(range.toDay) || world.day || dayOfTick(world.tick);
  if (!Number.isFinite(fromDay) || fromDay < 1) fromDay = 1;
  if (!Number.isFinite(toDay) || toDay < 1) toDay = 1;
  if (toDay < fromDay) [fromDay, toDay] = [toDay, fromDay];
  return {
    fromDay,
    toDay,
    fromTick: (fromDay - 1) * TICKS_PER_DAY,
    toTick: toDay * TICKS_PER_DAY - 1,
  };
}

function placeName(world, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const tile = world.map[y * W + x];
  if (tile === TILE.WATER) return '水边';
  if (world.structures.some((s) => s.type === 'camp' && Math.abs(s.x - x) + Math.abs(s.y - y) <= 3)) return '营地';
  if (tile === TILE.TREE) return '树林';
  if (tile === TILE.RUIN) return '废墟';
  return '空地';
}

function nameOf(world, id) {
  if (!id) return null;
  return world.agents.find((a) => a.id === id)?.name || '某个人';
}

function factResult(entry, fact) {
  if (entry.payload?.label) return entry.payload.label;
  if (entry.payload?.kind) return entry.payload.kind;
  if (entry.type === 'death' && fact?.object) return String(fact.object);
  return null;
}

// 从事实层里挑出这一段的条目，并补上「涉及的人 / 地点 / 结果」。
// 返回的是新对象，事件日志本身不会被改动。
export function collectChronicleFacts(world, range = {}) {
  const r = normalizeRange(world, range);
  const factsBySeq = new Map();
  for (const f of world.facts || []) {
    if (f.eventSeq && f.day >= r.fromDay && f.day <= r.toDay) factsBySeq.set(f.eventSeq, f);
  }

  const out = [];
  for (const e of world.eventLog || []) {
    if (!KEY_TYPES.has(e.type)) continue;
    if (e.day < r.fromDay || e.day > r.toDay) continue;

    const fact = factsBySeq.get(e.seq) || null;
    const ids = new Set();
    if (e.agentId) ids.add(e.agentId);
    for (const key of ['subjectId', 'targetId', 'killerId', 'deadId', 'heirId', 'studentId', 'teacherId']) {
      if (fact?.[key]) ids.add(fact[key]);
      if (e.payload?.[key]) ids.add(e.payload[key]);
    }

    let x = fact?.x;
    let y = fact?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      // 死亡没有在事实里记坐标，但坟在。
      const grave = world.structures.find(
        (s) => s.type === 'grave' && s.agentId === e.agentId
      );
      if (grave) {
        x = grave.x;
        y = grave.y;
      }
    }

    out.push({
      seq: e.seq,
      t: e.t,
      day: e.day,
      clock: e.clock,
      type: e.type,
      category: CATEGORY[e.type] || 'other',
      text: e.text,
      agentId: e.agentId || null,
      agentName: nameOf(world, e.agentId),
      people: [...ids].map((id) => ({ id, name: nameOf(world, id) })),
      place: placeName(world, x, y),
      result: factResult(e, fact),
      fact: fact ? { ...fact } : null,
    });
  }
  return out;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function digestOf(entries) {
  return fnv1a(entries.map((e) => `${e.seq}|${e.type}|${e.text}`).join('\n'));
}

export function daySummaries(world) {
  const byDay = new Map();
  for (const e of world.eventLog || []) {
    if (!KEY_TYPES.has(e.type)) continue;
    let d = byDay.get(e.day);
    if (!d) {
      d = {
        day: e.day,
        total: 0,
        deaths: 0,
        turnings: 0,
        institutions: 0,
        conflicts: 0,
        kin: 0,
        migrations: 0,
        lastText: '',
      };
      byDay.set(e.day, d);
    }
    d.total++;
    if (e.type === 'death' || e.type === 'bury') d.deaths++;
    else if (e.type === 'turning') d.turnings++;
    else if (e.type === 'institution') d.institutions++;
    else if (e.type === 'fight' || e.type === 'punish') d.conflicts++;
    else if (e.type === 'adopt' || e.type === 'inherit') d.kin++;
    else if (e.type === 'settle') d.migrations++;
    d.lastText = e.text;
  }
  return [...byDay.values()].sort((a, b) => a.day - b.day);
}

export function viewerContext(world, viewerId) {
  const agent = viewerId ? world.agents.find((a) => a.id === viewerId) : null;
  if (!agent) {
    return { kind: 'watcher', id: viewerId || null, name: '观看者' };
  }
  const relations = Object.entries(agent.relationships || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, value]) => ({ id, name: nameOf(world, id), value: Math.round(value) }));
  return {
    kind: 'resident',
    id: agent.id,
    name: agent.name,
    alive: agent.alive,
    identity: agent.identity,
    remembrance: Math.round(agent.remembrance ?? 0),
    beliefs: (agent.beliefs || []).slice(-20).map((b) => ({
      proposition: b.proposition,
      source: b.source,
      confidence: Math.round((b.confidence ?? 0) * 100) / 100,
    })),
    relations,
  };
}

function islandContext(world) {
  const alive = world.agents.filter((a) => a.alive);
  const dead = world.agents.filter((a) => !a.alive);
  const languages = {};
  for (const a of alive) {
    for (const key of Object.keys(a.languages || {})) {
      if (a.languages[key]) languages[key] = (languages[key] || 0) + 1;
    }
  }
  return {
    tick: world.tick,
    day: world.day,
    clock: world.clock,
    population: alive.length,
    alive: alive.map((a) => a.name),
    dead: dead.map((a) => a.name),
    languages,
    institutions: (world.institutions || [])
      .filter((i) => i.active)
      .map((i) => ({ id: i.id, kind: i.kind, active: i.active })),
  };
}

// 默认叙事器：不用模型，也能把一段事实读成一段文字。
export function defaultNarrator(context) {
  const { facts, range } = context;
  const header =
    range.fromDay === range.toDay
      ? `第 ${range.fromDay} 天`
      : `第 ${range.fromDay} 天到第 ${range.toDay} 天`;

  if (!facts.length) return `${header}，岛上没有值得记下的事。`;

  const lines = facts.map((f) => {
    const where = f.place ? `（${f.place}）` : '';
    return `· ${f.clock}${where} ${f.text}`;
  });
  return [`【${header}】`, ...lines].join('\n');
}

// ---------- 缓存 ----------
// WeakMap 挂在 world 上：重启即失效，也不进存档。
const caches = new WeakMap();
const pendings = new WeakMap();

function cacheFor(world) {
  let m = caches.get(world);
  if (!m) {
    m = new Map();
    caches.set(world, m);
  }
  return m;
}

function pendingFor(world) {
  let m = pendings.get(world);
  if (!m) {
    m = new Map();
    pendings.set(world, m);
  }
  return m;
}

function freezeFacts(entries) {
  return entries.map((e) => Object.freeze({ ...e, people: e.people.map((p) => Object.freeze({ ...p })) }));
}

/**
 * 生成一段观看者版本的编年史。
 *
 * @param world   世界状态（只读）
 * @param viewerId 观看者 id；可以是居民 id，也可以是任意字符串
 * @param range   { fromDay, toDay }
 * @param narrator 注入的叙事器 (context) => string | Promise<string>
 */
export async function narrate(
  world,
  viewerId,
  range = {},
  narrator = defaultNarrator,
  { cache: useCache = true, store = null } = {}
) {
  const r = normalizeRange(world, range);
  const entries = collectChronicleFacts(world, r);
  const digest = digestOf(entries);
  const key = `${viewerId ?? 'anonymous'}|${r.fromDay}|${r.toDay}|${digest}`;

  const cache = cacheFor(world);
  // store 是跨进程的叙事缓存（本机磁盘）；cache 是当前 world 的内存缓存。
  const hit = useCache ? cache.get(key) || store?.get(key) : null;
  if (hit) {
    if (useCache) cache.set(key, hit);
    return { ...hit, cached: true };
  }

  const pending = pendingFor(world);
  if (useCache && pending.has(key)) return pending.get(key);

  const context = {
    viewerId: viewerId ?? null,
    viewer: viewerContext(world, viewerId),
    range: { ...r },
    facts: freezeFacts(entries),
    island: islandContext(world),
  };

  const promise = Promise.resolve()
    .then(() => narrator(context))
    .then((text) => {
      const result = Object.freeze({
        viewerId: viewerId ?? null,
        range: { ...r },
        digest,
        facts: freezeFacts(entries),
        narrative: String(text ?? '').trim(),
        generated: { tick: world.tick, day: world.day || dayOfTick(world.tick), clock: world.clock },
        cached: false,
      });
      if (useCache) cache.set(key, result);
      if (store) store.set(key, result);
      pending.delete(key);
      return result;
    })
    .catch((err) => {
      pending.delete(key);
      throw err;
    });

  if (useCache) pending.set(key, promise);
  return promise;
}

// 规格里用的名字。
export const chronicle = narrate;
