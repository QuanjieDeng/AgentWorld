// test-foundation.js — C 阶段地基：确定性、事件日志、存档/重放、离线推进、事实/信念。
// 缝：种子世界 + tick；序列化与重放。
// 运行：node --test test-foundation.js

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorld,
  tick,
  logEvent,
  serializeWorld,
  loadWorld,
  replayDecisions,
  kill,
  MS_PER_TICK,
} from './engine.js';
import { advanceOffline, rebuildWorld } from './persistence.js';
import { processBrains } from './brain.js';

function observable(w) {
  return w.agents.map((agent) => ({
    name: agent.name,
    x: agent.x,
    y: agent.y,
    lastSay: agent.lastSay,
    action: agent.action,
    inventory: agent.inventory,
    relationships: agent.relationships,
    memory: agent.memory,
  }));
}

function runWorld(seed, ticks) {
  const world = createWorld(seed);
  for (let i = 0; i < ticks; i++) {
    tick(world);
    processBrains(world);
  }
  return world;
}

test('同样的种子和 tick 数，规则大脑跑出同样的世界', () => {
  const a = runWorld(7, 1440);
  const b = runWorld(7, 1440);
  assert.deepEqual(observable(a), observable(b));
  assert.deepEqual(a.log, b.log);
});

test('事件日志只追加，序号连续，不随界面日志的 400 条上限被截断', () => {
  const world = createWorld(7);
  const initial = world.eventLog.length;
  for (let i = 0; i < 450; i++) logEvent(world, 'talk', `第 ${i} 句话。`);
  assert.equal(world.eventLog.length, initial + 450);
  assert.equal(world.log.length, 400);
  for (let i = 1; i < world.eventLog.length; i++) {
    assert.equal(world.eventLog[i].seq, world.eventLog[i - 1].seq + 1);
  }
  assert.equal(world.log.at(-1).seq, world.eventLog.at(-1).seq);
});

test('世界可以存档并原样加载，继续跑也和没中断一样', () => {
  const world = runWorld(7, 600);
  const loaded = loadWorld(serializeWorld(world));

  assert.deepEqual(observable(loaded), observable(world));
  assert.deepEqual(loaded.eventLog, world.eventLog);

  for (let i = 0; i < 300; i++) {
    tick(world);
    processBrains(world);
    tick(loaded);
    processBrains(loaded);
  }

  assert.deepEqual(observable(loaded), observable(world));
  assert.deepEqual(loaded.eventLog, world.eventLog);
  assert.deepEqual(serializeWorld(loaded), serializeWorld(world));
});

test('记录下来的决策可以重放出同样的世界', () => {
  const cut = 300;
  const world = runWorld(7, cut);
  const saved = serializeWorld(world);
  const decisionsAtCut = world.decisionLog.length;

  for (let i = 0; i < 300; i++) {
    tick(world);
    processBrains(world);
  }
  const expected = serializeWorld(world);
  const forward = world.decisionLog.slice(decisionsAtCut);

  const replayed = loadWorld(saved);
  replayDecisions(replayed, forward);
  for (let i = 0; i < 300; i++) {
    tick(replayed);
    processBrains(replayed);
  }

  assert.deepEqual(serializeWorld(replayed), expected);
});

test('离线推进按真实时间换算 tick，只汇总关键事件，并遵守上限', () => {
  const world = createWorld(7);
  const startTick = world.tick;
  const startSeq = world.nextSeq - 1;

  // 让一个人在离线期间饿死，验证摘要确实抓到关键事件。
  const victim = world.agents[0];
  victim.hp = 0.01;
  victim.hunger = 0;

  const result = advanceOffline(world, MS_PER_TICK * 10, { maxTicks: 100 });

  assert.equal(result.fromTick, startTick);
  assert.equal(result.toTick, startTick + 10);
  assert.equal(result.ticks, 10);
  assert.ok(result.keyEvents.some((e) => e.type === 'death' && e.agentId === victim.id));
  assert.ok(!result.keyEvents.some((e) => e.type === 'talk'));
  assert.ok(result.keyEvents.every((e) => e.seq > startSeq));
  assert.ok(result.gone.includes(victim.id));
  assert.ok(!result.stillAlive.includes(victim.id));

  const capped = createWorld(7);
  const cappedResult = advanceOffline(capped, MS_PER_TICK * 500, { maxTicks: 20 });
  assert.equal(cappedResult.ticks, 20);
  assert.equal(capped.tick, cappedResult.fromTick + 20);
});

test('死亡同时写入事实层和目击者的信念，两者分开保存并可存档', () => {
  const world = createWorld(7);
  const victim = world.agents[0];
  const witness = world.agents[1];
  victim.x = witness.x;
  victim.y = witness.y;

  kill(world, victim, '测试。');

  const fact = world.facts.find((f) => f.type === 'death' && f.subjectId === victim.id);
  assert.ok(fact, '死亡应该写进事实层');

  const belief = witness.beliefs.find((b) => b.proposition.includes('死了'));
  assert.ok(belief, '目击者应该获得一条关于死亡的信念');
  assert.notEqual(fact.id, belief.id);

  const factBefore = JSON.stringify(fact);
  belief.proposition = '他没有死。';
  assert.equal(JSON.stringify(world.facts.find((f) => f.id === fact.id)), factBefore);

  const loaded = loadWorld(serializeWorld(world));
  assert.deepEqual(loaded.facts, world.facts);
  assert.deepEqual(
    loaded.agents.find((a) => a.id === witness.id).beliefs,
    world.agents.find((a) => a.id === witness.id).beliefs
  );
});

test('存档不包含 API Key 与模型配置', () => {
  const world = createWorld(7);
  world.api.key = 'sk-test-secret';
  world.api.base = 'http://example.invalid';
  world.api.model = 'test-model';
  world.config.llmAgents = 3;
  world.agents[0].useLLM = true;

  const saved = serializeWorld(world);
  assert.ok(!JSON.stringify(saved).includes('sk-test-secret'));
  assert.ok(!JSON.stringify(saved).includes('http://example.invalid'));
  assert.ok(!JSON.stringify(saved).includes('test-model'));

  const loaded = loadWorld(saved);
  assert.equal(loaded.api.key, '');
  assert.equal(loaded.api.base, '');
  assert.equal(loaded.api.model, '');
  assert.ok(loaded.agents.every((a) => !a.useLLM));
});

test('决策作为带序号的事件写进事件日志，并可据此重建世界', () => {
  const world = runWorld(7, 300);
  const decisions = world.eventLog.filter((e) => e.type === 'decision');

  assert.ok(decisions.length > 0);
  assert.ok(
    decisions.every(
      (e) => e.seq > 0 && e.payload && e.payload.action && typeof e.payload.rngAfter === 'number'
    )
  );
  for (let i = 1; i < world.eventLog.length; i++) {
    assert.equal(world.eventLog[i].seq, world.eventLog[i - 1].seq + 1);
  }

  const rebuilt = rebuildWorld({ seed: 7, decisions: world.decisionLog, tick: world.tick });
  assert.deepEqual(serializeWorld(rebuilt), serializeWorld(world));
});

test('存档归一化进行中的决策，往返完全一致', () => {
  const world = createWorld(7);
  world.agents[0].deciding = true;
  const saved = serializeWorld(world);
  assert.equal(saved.agents[0].deciding, false);

  const loaded = loadWorld(saved);
  assert.deepEqual(serializeWorld(loaded), saved);
});
