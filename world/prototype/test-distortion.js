// test-distortion.js — 记忆失真：转述只在信念层漂移，事实层不动。
// 缝：种子世界 + tick。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, tick, kill, recordBelief, snapshot, TILE, W } from './engine.js';

function agent(world, name) {
  return world.agents.find((a) => a.name === name);
}

function keepOnly(world, keep) {
  world.agents.forEach((a) => {
    if (!keep.includes(a)) a.alive = false;
  });
}

function deathScene() {
  const world = createWorld(7);
  const victim = agent(world, '阿禾');
  const witness = agent(world, '陈默');
  const listener = agent(world, '白姨');
  victim.x = 20;
  victim.y = 20;
  witness.x = 21;
  witness.y = 20;
  listener.x = 35;
  listener.y = 35;
  for (const x of [20, 21, 22]) world.map[20 * W + x] = TILE.GRASS;

  kill(world, victim, '被野兽咬死了。');
  witness.x = 21;
  witness.y = 20;
  listener.x = 22;
  listener.y = 20;
  keepOnly(world, [witness, listener]);
  return { world, victim, witness, listener };
}

function hearAboutDeath(world, witness, listener) {
  witness.action = { type: 'talk', target: listener.id, say: '你听说了吗？', remaining: 1 };
  tick(world);
  return listener.beliefs.find((b) => b.source === 'hearsay');
}

test('转述只写进信念，事实层完全不变', () => {
  const { world, victim, witness, listener } = deathScene();
  world.config.distortionChance = 1;

  const deathBelief = witness.beliefs.find((b) => b.claim?.kind === 'death');
  assert.ok(deathBelief, '目击者应该有一条关于死亡的结构化信念');
  const deathFactBefore = JSON.stringify(world.facts.find((f) => f.type === 'death'));
  const beliefBefore = JSON.stringify(deathBelief);
  assert.ok(!listener.beliefs.some((b) => b.claim?.kind === 'death'));

  const received = hearAboutDeath(world, witness, listener);

  assert.ok(received, '听的人应该得到一条转述');
  assert.equal(received.claim.subjectId, victim.id);
  assert.notEqual(received.claim.predicate, 'died', '传一遍就该走样');
  assert.ok(received.proposition.includes('被人杀'));
  assert.ok(received.confidence < deathBelief.confidence, '每传一次，确信度下降');
  assert.equal(received.sourceAgentId, witness.id, '转述要记得是谁说的');
  assert.equal(
    JSON.stringify(world.facts.find((f) => f.type === 'death')),
    deathFactBefore,
    '事实层不能被信念污染'
  );
  assert.ok(!world.facts.some((f) => f.predicate === 'was killed'));
  assert.equal(
    JSON.stringify(witness.beliefs.find((b) => b.claim?.kind === 'death')),
    beliefBefore,
    '说话的人自己的记忆不能被改写'
  );
});

test('不漂移时，听的人得到原样的说法', () => {
  const { world, witness, listener } = deathScene();
  world.config.distortionChance = 0;

  const received = hearAboutDeath(world, witness, listener);
  assert.equal(received.claim.predicate, 'died');
  assert.ok(received.proposition.includes('死了'));
});

test('同样的世界，转述结果完全可复现', () => {
  const first = deathScene();
  first.world.config.distortionChance = 0.7;
  const a = hearAboutDeath(first.world, first.witness, first.listener);

  const second = deathScene();
  second.world.config.distortionChance = 0.7;
  const b = hearAboutDeath(second.world, second.witness, second.listener);

  assert.deepEqual(a.claim, b.claim);
  assert.equal(a.proposition, b.proposition);
  assert.equal(a.confidence, b.confidence);
});

test('数量、时间、地点会在转述里走样，但不会变成事实', () => {
  const world = createWorld(7);
  const gatherer = agent(world, '阿禾');
  const listener = agent(world, '白姨');
  keepOnly(world, [gatherer, listener]);
  gatherer.x = 20;
  gatherer.y = 20;
  listener.x = 21;
  listener.y = 20;
  world.map[20 * W + 20] = TILE.GRASS;
  world.map[21 * W + 20] = TILE.GRASS;
  world.map[20 * W + 21] = TILE.BUSH;
  gatherer.action = { type: 'gather', remaining: 1 };
  tick(world);

  const before = gatherer.beliefs.find((b) => b.claim?.kind === 'gather');
  assert.ok(before, '采集的人应该记得自己采到了什么');

  world.config.distortionChance = 1;
  gatherer.action = { type: 'talk', target: listener.id, say: '我今天采到东西了。', remaining: 1 };
  tick(world);

  const heard = listener.beliefs.find((b) => b.claim?.kind === 'gather');
  assert.ok(heard, '听的人应该听到采集的事');
  assert.equal(heard.claim.subjectId, gatherer.id);
  const drifted = ['quantity', 'time', 'place'].some(
    (field) => heard.claim[field] !== before.claim[field]
  );
  assert.ok(drifted, '数量、时间或地点至少改了一处');

  const gatherFact = world.facts.find((f) => f.type === 'gather');
  assert.ok(gatherFact, '采集本身是事实');
  assert.equal(gatherFact.quantity, before.claim.quantity, '事实里的数量不能跟着传闻走');
});

test('二手消息还能继续传，但仍然只是信念', () => {
  const { world, victim, witness, listener } = deathScene();
  const third = agent(world, '老唐');
  third.alive = true;
  third.x = 23;
  third.y = 20;
  keepOnly(world, [witness, listener, third]);
  world.config.distortionChance = 1;

  hearAboutDeath(world, witness, listener);
  const deathFactBefore = JSON.stringify(world.facts.find((f) => f.type === 'death'));

  listener.action = { type: 'talk', target: third.id, say: '我也是听来的。', remaining: 1 };
  tick(world);

  const received = third.beliefs.find((b) => b.source === 'hearsay');
  assert.ok(received, '第三个人应该收到二手消息');
  assert.equal(received.claim.subjectId, victim.id);
  assert.equal(JSON.stringify(world.facts.find((f) => f.type === 'death')), deathFactBefore);
});

test('看见一个人还活着，就会推翻“他死了”的信念', () => {
  const world = createWorld(7);
  const believer = agent(world, '白姨');
  const alive = agent(world, '阿禾');
  keepOnly(world, [believer, alive]);
  believer.x = 20;
  believer.y = 20;
  alive.x = 21;
  alive.y = 20;
  recordBelief(world, believer, '阿禾死了。', 'hearsay', 0.7, {
    kind: 'death',
    subjectId: alive.id,
    predicate: 'died',
    object: '被野兽咬死了。',
  });

  tick(world);

  const deathBelief = believer.beliefs.find((b) => b.claim?.kind === 'death');
  assert.equal(deathBelief.corrected, true);
  assert.equal(deathBelief.confidence, 0);
  assert.ok(believer.beliefs.some((b) => b.source === 'saw'));
  assert.ok(!world.facts.some((f) => f.type === 'death'), '看见活人不会产生死亡事实');
});

test('观看者能同时拿到事实和信念', () => {
  const { world } = deathScene();
  const state = snapshot(world);
  assert.ok(state.facts.some((f) => f.type === 'death'));
  assert.ok(state.agents.some((a) => a.beliefs.length > 0));
});
