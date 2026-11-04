// sync.js — B 阶段地基：可交换的事件日志。
//
// 事件日志是权威输入：它同时包含「决策」（模型/规则提交的意图）和「结果」
// （引擎判定后发生的事）。给定种子 + 决策，引擎能逐字节重放出同样的结果，
// 所以两台机器之间只需要交换日志，不需要交换状态。
//
// 这里提供与传输无关的同步原语；HTTP 轮询适配器在 server.js：
//   1. 导出 / 校验：带连续性、种子和哈希的日志信封。
//   2. 重放：从种子 + 完整日志重建世界。
//   3. 追平：从本地快照 + 对方的一块后续日志追到同一个世界。
//
// 哈希是完整性校验（FNV-1a 64），不是密码学签名；节点签名与轮值排序尚未实现。

import {
  createWorld,
  tick,
  replayDecisions,
  serializeWorld,
  loadWorld,
  applyTurning,
  flushReplayRecords,
} from './engine.js';
import { processBrains } from './brain.js';

export const SYNC_PROTOCOL = 'island-journal/1';
export const TERM_EVENT = 'term';

// ---------- 规范化与哈希 ----------

export function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

// 64 位 FNV-1a。确定性、零依赖；只用于发现篡改与分叉，不作为签名。
export function hashText(text) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = BigInt.asUintN(64, h * prime);
  }
  return h.toString(16).padStart(16, '0');
}

export function canonicalEvent(event) {
  return JSON.parse(JSON.stringify(event));
}

export function eventsHash(events) {
  return hashText(stableStringify(events.map(canonicalEvent)));
}

// 从事件日志里取出决策。事件日志是唯一权威，decisionLog 只是它的投影。
export function decisionsFromEvents(events) {
  return events
    .filter((e) => e.type === 'decision' && e.payload?.action)
    .map((e) => ({
      seq: e.seq,
      tick: e.t,
      agentId: e.agentId,
      source: e.payload.source || 'rule',
      action: { ...e.payload.action },
      rngAfter: e.payload.rngAfter,
    }));
}

// 脱变发生在引擎判定之后、由模型在受控词表里选标签。标签写在 turning 事件里，
// 重放时必须用它，否则同一个 LLM 局会重放成另一个身份。
export function turningsFromEvents(events) {
  return events
    .filter((e) => e.type === 'turning' && e.payload?.trigger && e.payload?.label)
    .map((e) => ({
      seq: e.seq,
      t: e.t,
      agentId: e.agentId,
      trigger: e.payload.trigger,
      label: e.payload.label,
      reason: e.payload.reason || '',
    }));
}

// 交接记录必须原样进重放（含 seq / t / day / clock / text），
// 否则重放出来的事件哈希和对方对不上。
export function termRecordsFromEvents(events) {
  return events
    .filter((e) => e.type === TERM_EVENT && Number.isInteger(e.payload?.term) && e.payload?.authorityId)
    .map((e) => canonicalEvent(e));
}

// 在线租约也是日志的一部分：重放时必须在原序号位置改 presence / presenceUntil，
// 否则同一份日志会重放出“谁醒着”不一致的世界。
export function presenceRecordsFromEvents(events) {
  return events
    .filter(
      (e) =>
        e.type === 'presence' &&
        e.payload?.agentId &&
        typeof e.payload?.online === 'boolean'
    )
    .map((e) => canonicalEvent(e));
}

// 上传事件同样要按原序号重放：它会在那个时刻往世界里加一个人。
export function arrivalRecordsFromEvents(events) {
  return events
    .filter((e) => e.type === 'arrival' && e.payload?.arrival?.core)
    .map((e) => canonicalEvent(e));
}

/**
 * 从日志解出当前任期与日志权威。排序只看日志字段，不看墙钟：
 *   - 没有 term 事件时，按事件数轮换：term = floor(序号 / TERM_EVENTS)；
 *   - 有 term 事件时，最后一次交接记录优先，直到事件数轮换追上它。
 * nodes 必须是所有节点一致的有序名单（server.js 里已排序）。
 */
export function resolveTerm(events, { nodes = [], termEvents = 200 } = {}) {
  const count = events.length;
  const lastSeq = count ? events[count - 1].seq : 0;
  const baseTerm = Math.floor(lastSeq / Math.max(1, termEvents));

  let recorded = null;
  for (let i = count - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === TERM_EVENT && Number.isInteger(e.payload?.term) && e.payload?.authorityId) {
      recorded = e.payload;
      break;
    }
  }

  if (!recorded || baseTerm > recorded.term) {
    return {
      term: baseTerm,
      authorityId: nodes.length ? nodes[((baseTerm % nodes.length) + nodes.length) % nodes.length] : null,
      baseTerm,
      source: 'rotation',
    };
  }

  return {
    term: recorded.term,
    authorityId: recorded.authorityId,
    baseTerm,
    source: 'terms',
  };
}

// 状态哈希：只包含会影响下一步模拟的状态。
// 界面日志、暂停/倍速、API 配置、进行中的异步调用都不算。
export function stateHash(world) {
  const s = serializeWorld(world);
  const projection = {
    seed: s.seed,
    tick: s.tick,
    day: s.day,
    clock: s.clock,
    isNight: s.isNight,
    nightActive: s.nightActive,
    rngState: s.rngState,
    map: s.map,
    agents: s.agents,
    structures: s.structures,
    wolves: s.wolves,
    remains: s.remains,
    chronicle: s.chronicle,
    nextChronicleId: s.nextChronicleId,
    institutions: s.institutions,
    nextInstitutionId: s.nextInstitutionId,
    nextAgentId: s.nextAgentId,
    facts: s.facts,
    nextSeq: s.nextSeq,
    nextFactId: s.nextFactId,
    nextBeliefId: s.nextBeliefId,
    regrow: s.regrow,
    nextWolfId: s.nextWolfId,
    config: {
      distortionChance: s.config.distortionChance,
      remembranceDecay: s.config.remembranceDecay,
    },
    eventsHash: eventsHash(s.eventLog),
  };
  return hashText(stableStringify(projection));
}

// ---------- 导出 ----------

/**
 * 把世界在当前位置的日志导出成一个可交换信封。
 * 默认从第一条事件开始（完整日志）；传 fromSeq 可以只导后续的一段。
 *
 * 导出前应确保没有进行中的模型调用（world.inflight === 0），
 * 否则那个决策还没进日志，信封的头部状态是不完整的。
 */
export function exportJournal(world, { fromSeq = 1, nodeId = 'local', epoch = 1, prevHash = null } = {}) {
  const firstSeq = world.eventLog[0]?.seq ?? 1;
  const start = Math.max(firstSeq, Math.floor(Number(fromSeq) || firstSeq));
  const events = world.eventLog.filter((e) => e.seq >= start).map(canonicalEvent);
  const decisions = decisionsFromEvents(events);
  const toSeq = events.length ? events[events.length - 1].seq : start - 1;

  return {
    protocol: SYNC_PROTOCOL,
    seed: world.seed,
    nodeId,
    epoch,
    fromSeq: start,
    toSeq,
    fromTick: events[0]?.t ?? world.tick,
    toTick: world.tick,
    prevHash:
      prevHash ??
      (start > firstSeq
        ? eventsHash(world.eventLog.filter((e) => e.seq < start))
        : null),
    events,
    decisions,
    eventsHash: eventsHash(events),
    decisionsHash: hashText(stableStringify(decisions)),
    stateHash: stateHash(world),
    inflight: world.inflight || 0,
    ready: !(world.inflight > 0),
    createdAt: { tick: world.tick, day: world.day || 1, clock: world.clock || '08:00' },
  };
}

// ---------- 校验 ----------

function fail(reason) {
  return { ok: false, reason };
}

/**
 * 校验信封自身是否自洽：协议、种子、序号连续、事件哈希、
 * 以及 decisions 确实是 events 的投影（防止单独篡改决策）。
 * 它不判断这份日志和本地世界谁更新。
 */
export function verifyJournal(envelope) {
  if (!envelope || typeof envelope !== 'object') return fail('not an object');
  if (envelope.protocol !== SYNC_PROTOCOL) return fail('protocol mismatch');
  if (!Number.isInteger(envelope.seed)) return fail('bad seed');
  if (!Array.isArray(envelope.events)) return fail('missing events');
  if (!Array.isArray(envelope.decisions)) return fail('missing decisions');
  if (!Number.isInteger(envelope.fromSeq) || !Number.isInteger(envelope.toSeq)) {
    return fail('bad sequence range');
  }
  if (!Number.isFinite(envelope.toTick) || envelope.toTick < envelope.fromTick) {
    return fail('bad tick range');
  }

  for (let i = 0; i < envelope.events.length; i++) {
    const e = envelope.events[i];
    if (e.seq !== envelope.fromSeq + i) return fail(`sequence gap at index ${i}`);
    if (i > 0 && e.t < envelope.events[i - 1].t) return fail(`tick went backwards at seq ${e.seq}`);
  }
  if (envelope.events.length === 0) {
    if (envelope.toSeq !== envelope.fromSeq - 1) return fail('empty journal has bad range');
  } else if (envelope.events[envelope.events.length - 1].seq !== envelope.toSeq) {
    return fail('toSeq does not match last event');
  }

  const computedEvents = eventsHash(envelope.events);
  if (computedEvents !== envelope.eventsHash) return fail('event hash mismatch');

  const computedDecisions = decisionsFromEvents(envelope.events);
  if (stableStringify(computedDecisions) !== stableStringify(envelope.decisions)) {
    return fail('decisions do not match events');
  }
  if (hashText(stableStringify(envelope.decisions)) !== envelope.decisionsHash) {
    return fail('decision hash mismatch');
  }
  if (typeof envelope.stateHash !== 'string' || !envelope.stateHash) {
    return fail('missing state hash');
  }

  return { ok: true };
}

// 两块日志能不能接上：后一块必须紧接前一块的序号，并引用前一块的哈希。
export function verifyChain(prev, next) {
  const a = verifyJournal(prev);
  if (!a.ok) return fail(`previous journal: ${a.reason}`);
  const b = verifyJournal(next);
  if (!b.ok) return fail(`next journal: ${b.reason}`);
  if (prev.seed !== next.seed) return fail('seed mismatch between chunks');
  if (next.fromSeq !== prev.toSeq + 1) return fail('chunks are not adjacent');
  if (next.prevHash !== prev.eventsHash) return fail('chunk does not reference previous hash');
  if (next.toTick < prev.toTick) return fail('next chunk goes backwards');
  return { ok: true };
}

// ---------- 重放 ----------

function applyRecordedTurnings(world, turnings) {
  for (const turning of turnings) {
    const agent = world.agents.find((a) => a.id === turning.agentId);
    if (!agent?.alive || agent.turningPoints.some((t) => t.trigger === turning.trigger)) continue;
    applyTurning(world, agent, turning.trigger, turning.label, turning.reason);
  }
}

function clearReplay(world) {
  // 重放模式结束后必须关掉，否则这个世界的居民再也不会做新决定。
  // 日志末尾可能还剩没有后续事件触发的交接记录，收尾时补进日志。
  flushReplayRecords(world);
  world.replay = null;
  world.pendingDecisions = [];
  return world;
}

/**
 * 从种子 + 完整日志重建世界。
 * 默认重放到信封的 toTick；也可以只重放到某一刻。
 */
export function rebuildFromJournal(envelope, { until = envelope.toTick } = {}) {
  const check = verifyJournal(envelope);
  if (!check.ok) throw new Error(`journal invalid: ${check.reason}`);
  if (envelope.fromSeq > 1) {
    throw new Error('journal is not from genesis; use applyChunk with a snapshot');
  }

  const target = Math.max(0, Math.floor(until));
  const decisions = envelope.decisions.filter((d) => d.tick <= target);
  const turnings = turningsFromEvents(envelope.events).filter((t) => t.t <= target);
  const terms = termRecordsFromEvents(envelope.events).filter((e) => e.t <= target);
  const presences = presenceRecordsFromEvents(envelope.events).filter((e) => e.t <= target);
  const arrivals = arrivalRecordsFromEvents(envelope.events).filter((e) => e.t <= target);
  const world = createWorld(envelope.seed);
  replayDecisions(world, decisions, turnings, terms, presences, arrivals);
  while (world.tick < target) {
    tick(world);
    processBrains(world);
  }
  applyRecordedTurnings(world, world.replay?.turnings || []);
  return clearReplay(world);
}

export function cloneWorld(world) {
  return loadWorld(serializeWorld(world));
}

function sliceEvents(world, fromSeq, toSeq) {
  return world.eventLog.filter((e) => e.seq >= fromSeq && e.seq <= toSeq);
}

/**
 * 从本地快照 + 对方的一块后续日志追平。
 * 本地必须已经包含 chunk.fromSeq 之前的事件；缺了就是有空洞，直接拒绝。
 * 返回新的世界，不修改传入的世界。
 */
export function applyChunk(localWorld, chunk) {
  const check = verifyJournal(chunk);
  if (!check.ok) return { ok: false, reason: check.reason };
  if (chunk.seed !== localWorld.seed) return { ok: false, reason: 'seed mismatch' };

  const nextSeq = localWorld.nextSeq;
  if (chunk.fromSeq > nextSeq) return { ok: false, reason: 'gap: missing earlier events' };
  if (chunk.fromSeq > 1) {
    const localHeadHash = eventsHash(localWorld.eventLog.filter((e) => e.seq < chunk.fromSeq));
    if (chunk.prevHash !== localHeadHash) return { ok: false, reason: 'previous hash mismatch' };
  }
  if (chunk.toTick < localWorld.tick) return { ok: false, reason: 'stale chunk' };

  const overlapEnd = Math.min(chunk.toSeq, nextSeq - 1);
  if (chunk.fromSeq <= overlapEnd) {
    const localPrefix = sliceEvents(localWorld, chunk.fromSeq, overlapEnd);
    const remotePrefix = chunk.events.filter((e) => e.seq <= overlapEnd);
    if (stableStringify(localPrefix) !== stableStringify(remotePrefix)) {
      return { ok: false, reason: 'overlapping events diverged' };
    }
  }

  if (chunk.toTick === localWorld.tick && chunk.toSeq < nextSeq) {
    const matched = stateHash(localWorld) === chunk.stateHash;
    return { ok: true, world: localWorld, matched, replayed: false };
  }

  const world = cloneWorld(localWorld);
  const decisions = chunk.decisions.filter((d) => d.seq >= nextSeq && d.tick <= chunk.toTick);
  const turnings = turningsFromEvents(chunk.events).filter((t) => t.t <= chunk.toTick);
  const terms = termRecordsFromEvents(chunk.events).filter((e) => e.t <= chunk.toTick);
  const presences = presenceRecordsFromEvents(chunk.events).filter(
    (e) => e.seq >= nextSeq && e.t <= chunk.toTick
  );
  const arrivals = arrivalRecordsFromEvents(chunk.events).filter(
    (e) => e.seq >= nextSeq && e.t <= chunk.toTick
  );
  replayDecisions(world, decisions, turnings, terms, presences, arrivals);
  if (decisions.some((d) => d.tick <= localWorld.tick)) processBrains(world);
  while (world.tick < chunk.toTick) {
    tick(world);
    processBrains(world);
  }
  applyRecordedTurnings(world, turnings);

  // 块的最后一条可能是 term / presence / arrival：它要等下一次 logEvent
  // 才会被插回。比较前必须先收尾，否则单条事件的块永远对不上。
  flushReplayRecords(world);
  const eventMatch =
    eventsHash(sliceEvents(world, chunk.fromSeq, chunk.toSeq)) === chunk.eventsHash;
  const matched = stateHash(world) === chunk.stateHash && eventMatch;
  if (!matched && process.env.PEER_DEBUG === '1') {
    console.log(
      `  [chunk mismatch] seq ${chunk.fromSeq}-${chunk.toSeq} tick ${chunk.fromTick}-${chunk.toTick} ` +
        `local tick ${localWorld.tick} events ${chunk.events.length} ` +
        `types ${[...new Set(chunk.events.map((e) => e.type))].join(',')}`
    );
  }
  clearReplay(world);

  return { ok: true, world, matched, replayed: true, eventMatch };
}

/**
 * 用一份完整日志把本地世界换成一个重放出来的世界。
 * 只接受从第一条事件开始的日志；落后的节点也可以用它从零重建。
 */
export function catchUp(localWorld, envelope) {
  const check = verifyJournal(envelope);
  if (!check.ok) return { ok: false, reason: check.reason };
  if (envelope.seed !== localWorld.seed) return { ok: false, reason: 'seed mismatch' };
  if (envelope.toTick < localWorld.tick) return { ok: false, reason: 'stale journal' };
  if (envelope.fromSeq > 1) {
    return { ok: false, reason: 'journal is not from genesis; use applyChunk' };
  }

  let world;
  try {
    world = rebuildFromJournal(envelope);
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }

  const eventMatch =
    eventsHash(sliceEvents(world, envelope.fromSeq, envelope.toSeq)) === envelope.eventsHash;
  const matched = stateHash(world) === envelope.stateHash && eventMatch;

  return {
    ok: true,
    world,
    matched,
    eventMatch,
    localMatched:
      localWorld.tick === envelope.toTick ? stateHash(localWorld) === envelope.stateHash : null,
  };
}

// 给轮值排序预留的比较：先比任期，再比覆盖到的序号，最后比节点名。
// 现在还没有接入任何网络或投票，只是一个确定性的先后顺序。
export function compareJournals(a, b) {
  if (a.seed !== b.seed) return 0;
  if ((a.epoch || 0) !== (b.epoch || 0)) return (a.epoch || 0) - (b.epoch || 0);
  if (a.toSeq !== b.toSeq) return a.toSeq - b.toSeq;
  return String(a.nodeId || '').localeCompare(String(b.nodeId || ''));
}
