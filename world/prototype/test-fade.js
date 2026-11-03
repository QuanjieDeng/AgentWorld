// test-fade.js — 淡出（被惦记轴）：被惦记的人留下，长期无人提起的人被抹去。
// 缝：种子世界 + tick；衰减本身用导出的 decayRemembrance 精确驱动。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorld,
  tick,
  kill,
  decayRemembrance,
  rememberAgent,
  deliverLetter,
  serializeWorld,
  loadWorld,
  TICKS_PER_DAY,
  MENTION_GAIN,
  TILE,
  W,
} from './engine.js';
import { processBrains } from './brain.js';

function agent(world, name) {
  return world.agents.find((a) => a.name === name);
}

function keepOnly(world, keep) {
  world.agents.forEach((a) => {
    if (!keep.includes(a)) a.alive = false;
  });
}

function place(world, a, x, y) {
  a.x = x;
  a.y = y;
  world.map[y * W + x] = TILE.GRASS;
}

test('长期无人提起的人会逐级淡出，最后被世界抹去', () => {
  const world = createWorld(7);
  const a = agent(world, '阿禾');
  keepOnly(world, [a]);
  world.config.remembranceDecay = 5;
  a.remembrance = 1;
  world.structures.push({ type: 'shelter', x: 20, y: 20, ownerId: a.id });

  decayRemembrance(world);
  assert.equal(a.fadeStage, 1);
  assert.equal(a.alive, true);

  decayRemembrance(world);
  assert.equal(a.fadeStage, 2);
  assert.equal(a.alive, true);

  decayRemembrance(world);
  assert.equal(a.faded, true);
  assert.equal(a.alive, false);
  assert.ok(!world.structures.some((s) => s.type === 'grave'), '被抹去的人不留坟');
  assert.equal(world.structures.find((s) => s.type === 'shelter').ownerId, null);
});

test('被人提起会把淡出进度拉回来', () => {
  const world = createWorld(7);
  const a = agent(world, '阿禾');
  keepOnly(world, [a]);
  world.config.remembranceDecay = 5;
  a.remembrance = 1;

  decayRemembrance(world);
  assert.equal(a.fadeStage, 1);
  rememberAgent(world, a.id, 6);
  decayRemembrance(world);
  assert.equal(a.fadeStage, 0, '被惦记就不继续淡出');
  assert.equal(a.alive, true);
});

test('哪怕只被提起一点，也会重置淡出阶段', () => {
  const world = createWorld(7);
  const a = agent(world, '阿禾');
  keepOnly(world, [a]);
  world.config.remembranceDecay = 5;
  a.remembrance = 0;
  a.fadeStage = 2;

  rememberAgent(world, a.id, 1);
  assert.equal(a.fadeStage, 0);
  decayRemembrance(world);
  assert.equal(a.fadeStage, 1, '只掉一级，不会直接抹去');
  assert.equal(a.alive, true);
});

test('每天的世界时间推进会让无人提起的人开始淡出', () => {
  const world = createWorld(7);
  const a = agent(world, '阿禾');
  keepOnly(world, [a]);
  world.config.remembranceDecay = 5;
  a.remembrance = 1;
  world.tick = TICKS_PER_DAY - 1;
  world.nightActive = true;
  world.wolves = [];

  tick(world);

  assert.equal(a.fadeStage, 1);
});

test('快被忘记的人会主动去找人说话', () => {
  const world = createWorld(7);
  const a = agent(world, '阿禾');
  const other = agent(world, '白姨');
  keepOnly(world, [a, other]);
  place(world, a, 20, 20);
  place(world, other, 21, 20);
  a.remembrance = 5;
  a.hunger = 80;
  a.energy = 80;
  a.action = null;
  a.cooldownUntil = 0;
  a.deciding = false;

  tick(world);
  processBrains(world);

  assert.equal(a.queuedAction?.type, 'talk');
});

test('在线的人不会淡出', () => {
  const world = createWorld(7);
  const a = agent(world, '阿禾');
  keepOnly(world, [a]);
  a.presence = 'online';
  a.remembrance = 1;
  world.config.remembranceDecay = 5;

  decayRemembrance(world);
  assert.equal(a.remembrance, 1);
  assert.equal(a.fadeStage, 0);
});

test('说话会让说话的人被记住', () => {
  const world = createWorld(7);
  const speaker = agent(world, '周远');
  const listener = agent(world, '林氏');
  keepOnly(world, [speaker, listener]);
  place(world, speaker, 20, 20);
  place(world, listener, 21, 20);
  const before = speaker.remembrance;

  speaker.action = { type: 'talk', target: listener.id, say: '你还在吗？', remaining: 1 };
  tick(world);

  assert.ok(speaker.remembrance > before);
});

test('祖先的声音也算一次被惦记', () => {
  const world = createWorld(7);
  const a = agent(world, '阿禾');
  a.mentorId = 'a1';
  const before = a.remembrance;

  assert.equal(deliverLetter(world, a, '别推那扇门。'), true);
  assert.ok(a.remembrance > before);
});

test('被人转述也会被记住', () => {
  const world = createWorld(7);
  const gatherer = agent(world, '阿禾');
  const listener = agent(world, '白姨');
  keepOnly(world, [gatherer, listener]);
  place(world, gatherer, 20, 20);
  place(world, listener, 21, 20);
  world.map[20 * W + 21] = TILE.BUSH;
  gatherer.action = { type: 'gather', remaining: 1 };
  tick(world);

  const before = gatherer.remembrance;
  gatherer.action = { type: 'talk', target: listener.id, say: '我今天采到东西了。', remaining: 1 };
  tick(world);

  assert.ok(
    listener.beliefs.some((b) => b.claim?.kind === 'gather'),
    '听的人应该收到关于采集者的转述'
  );
  assert.ok(
    gatherer.remembrance - before >= MENTION_GAIN.retell,
    '被转述比普通交谈更让人被记住'
  );
});

test('埋葬死者会增加死者自己的被惦记程度', () => {
  const world = createWorld(7);
  const dead = agent(world, '阿禾');
  const mourner = agent(world, '白姨');
  keepOnly(world, [dead, mourner]);
  place(world, dead, 20, 20);
  place(world, mourner, 21, 20);
  kill(world, dead, '饿死了。');
  const before = dead.remembrance;

  mourner.action = { type: 'bury', remaining: 1 };
  tick(world);

  assert.ok(dead.remembrance > before);
});

test('被记住程度与淡出阶段可以存档', () => {
  const world = createWorld(7);
  const a = agent(world, '阿禾');
  a.remembrance = 33;
  a.fadeStage = 2;
  a.presence = 'online';

  const loaded = loadWorld(serializeWorld(world));
  const b = loaded.agents.find((x) => x.id === a.id);
  assert.equal(b.remembrance, 33);
  assert.equal(b.fadeStage, 2);
  assert.equal(b.presence, 'online');
});
