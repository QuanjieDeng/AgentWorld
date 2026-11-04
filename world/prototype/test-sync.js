// test-sync.js — B 阶段地基：事件日志导出、校验、重放与两节点收敛。
// 缝：种子世界 + tick；序列化/重放；日志信封。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorld,
  tick,
  serializeWorld,
  loadWorld,
  TURNING_TRIGGERS,
  logDecision,
  logTermEvent,
  applyTurning,
} from './engine.js';
import { processBrains } from './brain.js';
import {
  SYNC_PROTOCOL,
  exportJournal,
  verifyJournal,
  verifyChain,
  rebuildFromJournal,
  applyChunk,
  catchUp,
  cloneWorld,
  stateHash,
  eventsHash,
  compareJournals,
  resolveTerm,
} from './sync.js';

function runWorld(seed, ticks) {
  const world = createWorld(seed);
  for (let i = 0; i < ticks; i++) {
    tick(world);
    processBrains(world);
  }
  return world;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('导出的日志自洽、可校验，序号从第一条事件连续到最新', () => {
  const world = runWorld(7, 240);
  const journal = exportJournal(world, { nodeId: 'node-a' });

  assert.equal(journal.protocol, SYNC_PROTOCOL);
  assert.equal(journal.seed, 7);
  assert.equal(journal.nodeId, 'node-a');
  assert.equal(journal.fromSeq, 1);
  assert.equal(journal.toSeq, world.nextSeq - 1);
  assert.equal(journal.toTick, world.tick);
  assert.ok(journal.events.length > 0);
  assert.equal(journal.eventsHash, eventsHash(journal.events));
  assert.ok(journal.decisions.length > 0);
  assert.deepEqual(verifyJournal(journal), { ok: true });
});

test('同一个世界的日志哈希是确定的', () => {
  const a = exportJournal(runWorld(7, 180));
  const b = exportJournal(runWorld(7, 180));
  assert.equal(a.eventsHash, b.eventsHash);
  assert.equal(a.stateHash, b.stateHash);
  assert.equal(a.decisionsHash, b.decisionsHash);
});

test('状态哈希在存档往返后保持不变，并对单点改动敏感', () => {
  const world = runWorld(7, 180);
  const loaded = loadWorld(serializeWorld(world));
  assert.equal(stateHash(loaded), stateHash(world));

  const before = stateHash(world);
  world.agents[0].hp -= 0.001;
  assert.notEqual(stateHash(world), before);
});

test('从种子 + 完整日志重建出逐字节相同的世界', () => {
  const world = runWorld(7, 300);
  const journal = exportJournal(world);
  const rebuilt = rebuildFromJournal(journal);

  assert.equal(stateHash(rebuilt), stateHash(world));
  assert.equal(eventsHash(rebuilt.eventLog), eventsHash(world.eventLog));
  assert.deepEqual(serializeWorld(rebuilt), serializeWorld(world));
});

test('日志经过 JSON 传输后仍能校验并重建', () => {
  const world = runWorld(7, 200);
  const received = JSON.parse(JSON.stringify(exportJournal(world, { nodeId: 'node-a' })));

  assert.deepEqual(verifyJournal(received), { ok: true });
  const rebuilt = rebuildFromJournal(received);

  assert.equal(stateHash(rebuilt), stateHash(world));
  assert.equal(eventsHash(rebuilt.eventLog), received.eventsHash);
});

test('篡改事件、决策或删掉一段都会被校验发现', () => {
  const journal = exportJournal(runWorld(7, 120));

  const alteredEvent = clone(journal);
  alteredEvent.events[3].text += '（伪造）';
  assert.equal(verifyJournal(alteredEvent).ok, false);

  const alteredDecision = clone(journal);
  alteredDecision.decisions[0].action.type = 'die';
  assert.equal(verifyJournal(alteredDecision).ok, false);

  const dropped = clone(journal);
  dropped.events.splice(2, 1);
  dropped.decisions = dropped.events
    .filter((e) => e.type === 'decision')
    .map((e) => ({ seq: e.seq, tick: e.t, agentId: e.agentId, source: 'rule', action: e.payload.action }));
  assert.equal(verifyJournal(dropped).ok, false, '序号断开或哈希不符都应被拒绝');

  const badSeed = clone(journal);
  badSeed.seed = 'seven';
  assert.equal(verifyJournal(badSeed).ok, false);
});

test('快照 + 后续日志块可以追到同一个世界', () => {
  const early = runWorld(7, 240);
  const late = runWorld(7, 480);

  const first = exportJournal(early, { nodeId: 'node-a' });
  const second = exportJournal(late, {
    fromSeq: first.toSeq + 1,
    prevHash: first.eventsHash,
    nodeId: 'node-a',
  });

  assert.deepEqual(verifyChain(first, second), { ok: true });
  assert.equal(second.fromSeq, first.toSeq + 1);
  assert.equal(second.prevHash, first.eventsHash);

  const local = loadWorld(serializeWorld(early));
  const result = applyChunk(local, second);

  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(result.replayed, true);
  assert.equal(stateHash(result.world), stateHash(late));
  assert.equal(eventsHash(result.world.eventLog), eventsHash(late.eventLog));
});

test('相同 tick 上追加的决策也能追平', () => {
  const primary = createWorld(7);
  const mirror = cloneWorld(primary);
  const agent = primary.agents[0];
  const action = { type: 'gather', remaining: 2 };
  agent.queuedAction = { ...action };
  agent.deciding = false;
  agent.cooldownUntil = primary.tick + 2;
  logDecision(primary, {
    agentId: agent.id,
    source: 'rule',
    action,
    rngAfter: primary.rng.getState(),
  });

  const chunk = exportJournal(primary, { fromSeq: mirror.nextSeq });
  const result = applyChunk(mirror, chunk);

  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(result.world.tick, primary.tick);
  assert.equal(stateHash(result.world), stateHash(primary));
});

test('同一 tick 上异步返回的脱变结果也同步到镜像', () => {
  const primary = createWorld(7);
  const mirror = cloneWorld(primary);
  const agent = primary.agents[0];
  applyTurning(primary, agent, 'killed', '手上带血的人', '模型选了这个标签。');

  const chunk = exportJournal(primary, { fromSeq: mirror.nextSeq });
  const result = applyChunk(mirror, chunk);

  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(result.world.agents[0].identity, '手上带血的人');
  assert.equal(stateHash(result.world), stateHash(primary));
});

test('落后的节点用完整日志追平，追平后还能继续和对方保持一致', () => {
  const ahead = runWorld(7, 480);
  const behind = runWorld(7, 120);
  const journal = exportJournal(ahead);

  const result = catchUp(behind, journal);
  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(stateHash(result.world), stateHash(ahead));

  for (let i = 0; i < 120; i++) {
    tick(ahead);
    processBrains(ahead);
    tick(result.world);
    processBrains(result.world);
  }

  assert.equal(stateHash(result.world), stateHash(ahead), '追平后两边继续跑仍应一致');
  assert.deepEqual(serializeWorld(result.world), serializeWorld(ahead));
});

test('重放使用日志里的脱变标签，而不是确定性标签', () => {
  const world = runWorld(7, 720);
  const journal = exportJournal(world);
  const turningEvent = journal.events.find((e) => e.type === 'turning' && e.payload?.trigger);
  assert.ok(turningEvent, '这段模拟里应该至少发生一次脱变');

  const labels = TURNING_TRIGGERS[turningEvent.payload.trigger].labels;
  const original = turningEvent.payload.label;
  const alternative = labels.find((label) => label !== original);
  assert.ok(alternative);

  // 模拟一份自洽的日志：这一局当时由一个模型选了另一个受控标签。
  turningEvent.payload.label = alternative;
  turningEvent.text = turningEvent.text.replace(original, alternative);
  journal.eventsHash = eventsHash(journal.events);
  assert.deepEqual(verifyJournal(journal), { ok: true });

  const rebuilt = rebuildFromJournal(journal);
  const agent = rebuilt.agents.find((a) => a.id === turningEvent.agentId);
  assert.equal(agent.identity, alternative);
  assert.ok(agent.turningPoints.some((t) => t.label === alternative));
  assert.ok(rebuilt.chronicle.some((c) => c.kind === 'turning' && c.label === alternative));
});

test('较旧的日志不会把节点倒退回过去', () => {
  const early = runWorld(7, 120);
  const late = runWorld(7, 240);
  const result = catchUp(late, exportJournal(early));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale journal');
});

test('不同种子的日志不会被接受', () => {
  const journal = exportJournal(runWorld(7, 120));
  const other = createWorld(8);
  const result = catchUp(other, journal);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'seed mismatch');
});

test('重复应用同一块是幂等的', () => {
  const early = runWorld(7, 200);
  const late = runWorld(7, 360);
  const first = exportJournal(early);
  const second = exportJournal(late, { fromSeq: first.toSeq + 1, prevHash: first.eventsHash });

  const once = applyChunk(loadWorld(serializeWorld(early)), second);
  assert.equal(once.ok, true);

  const twice = applyChunk(once.world, second);
  assert.equal(twice.ok, true);
  assert.equal(twice.replayed, false);
  assert.equal(twice.matched, true);
  assert.equal(stateHash(twice.world), stateHash(late));
});

test('断开的日志块无法串成一条链', () => {
  const early = runWorld(7, 200);
  const late = runWorld(7, 360);
  const first = exportJournal(early);
  const gap = exportJournal(late, { fromSeq: first.toSeq + 2, prevHash: first.eventsHash });

  const chain = verifyChain(first, gap);
  assert.equal(chain.ok, false);
  assert.equal(chain.reason, 'chunks are not adjacent');
});

test('导出日志里不包含 API Key 或模型配置', () => {
  const world = runWorld(7, 60);
  world.api.key = 'sk-test-secret';
  world.api.base = 'http://example.invalid';
  world.api.model = 'test-model';
  world.config.llmAgents = 4;
  world.agents[0].useLLM = true;

  const journal = exportJournal(world);
  const text = JSON.stringify(journal);
  assert.ok(!text.includes('sk-test-secret'));
  assert.ok(!text.includes('http://example.invalid'));
  assert.ok(!text.includes('test-model'));
  assert.ok(!text.includes('"llmAgents"'));
});

test('没有交接记录时，任期与权威由事件数轮换决定', () => {
  const events = Array.from({ length: 25 }, (_, i) => ({ seq: i + 1, t: 0, type: 'x' }));
  const state = resolveTerm(events, { nodes: ['a', 'b', 'c'], termEvents: 10 });

  assert.equal(state.baseTerm, 2);
  assert.equal(state.term, 2);
  assert.equal(state.authorityId, 'c');
  assert.equal(state.source, 'rotation');
});

test('交接记录优先于事件数轮换，直到日志自己追上越过它', () => {
  const build = (count) => {
    const events = Array.from({ length: count }, (_, i) => ({ seq: i + 1, t: 0, type: 'x' }));
    events[15] = {
      seq: 16,
      t: 0,
      type: 'term',
      payload: { term: 4, authorityId: 'b', reason: 'lease-expired' },
    };
    return events;
  };

  const before = resolveTerm(build(45), { nodes: ['a', 'b', 'c'], termEvents: 10 });
  assert.equal(before.term, 4);
  assert.equal(before.authorityId, 'b');
  assert.equal(before.source, 'terms');

  // 事件数轮换到第 6 任后，交接记录不再压过轮换。
  const after = resolveTerm(build(60), { nodes: ['a', 'b', 'c'], termEvents: 10 });
  assert.equal(after.term, 6);
  assert.equal(after.authorityId, 'a');
  assert.equal(after.source, 'rotation');
});

test('交接记录写进日志后能逐字节重放，也能同步给落后的节点', () => {
  const early = runWorld(7, 200);
  const primary = loadWorld(serializeWorld(early));
  logTermEvent(primary, { term: 4, authorityId: 'peer-b', reason: 'lease-expired' });
  for (let i = 0; i < 120; i++) {
    tick(primary);
    processBrains(primary);
  }

  const journal = exportJournal(primary);
  const termEvent = journal.events.find((e) => e.type === 'term');
  assert.ok(termEvent, '导出的日志里应当有交接记录');
  assert.equal(termEvent.payload.authorityId, 'peer-b');

  const rebuilt = rebuildFromJournal(journal);
  assert.equal(stateHash(rebuilt), stateHash(primary));
  assert.deepEqual(serializeWorld(rebuilt), serializeWorld(primary));
  assert.equal(
    rebuilt.eventLog.find((e) => e.type === 'term')?.seq,
    termEvent.seq,
    '重放必须把交接记录放回原来的序号'
  );

  const chunk = exportJournal(primary, { fromSeq: early.nextSeq });
  const result = applyChunk(loadWorld(serializeWorld(early)), chunk);
  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(stateHash(result.world), stateHash(primary));
  assert.ok(result.world.eventLog.some((e) => e.type === 'term'));
});

test('日志比较给出确定的先后顺序，为轮值排序预留', () => {
  const world = runWorld(7, 120);
  const base = exportJournal(world, { nodeId: 'a', epoch: 1 });
  const newer = exportJournal(runWorld(7, 240), { nodeId: 'b', epoch: 2 });

  assert.ok(compareJournals(newer, base) > 0);
  assert.ok(compareJournals(base, newer) < 0);
  assert.equal(compareJournals(base, clone(base)), 0);
});
