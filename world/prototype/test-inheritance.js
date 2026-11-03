// test-inheritance.js — 收养/收徒、继承、无主遗产与搬入。
// 缝：种子世界 + tick。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorld,
  tick,
  kill,
  recordBelief,
  deliverLetter,
  letterCooldownLeft,
  LETTER_COOLDOWN_TICKS,
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

function grass(world, x, y) {
  world.map[y * W + x] = TILE.GRASS;
}

test('收养之后，继承人得到财产、技能、知识和信念', () => {
  const world = createWorld(7);
  const mentor = agent(world, '陈默'); // 铁匠
  const heir = agent(world, '阿禾'); // 流浪者
  keepOnly(world, [mentor, heir]);
  mentor.x = 20;
  mentor.y = 20;
  heir.x = 21;
  heir.y = 20;
  grass(world, 20, 20);
  grass(world, 21, 20);
  mentor.relationships[heir.id] = 30;
  mentor.inventory = { food: 5, wood: 7, stone: 3, weapon: 1 };
  mentor.knows.fish = true;
  recordBelief(world, mentor, '有人偷了粮食。', 'witness', 0.8, {
    kind: 'gather',
    subjectId: mentor.id,
    predicate: 'gathered',
    object: 'food',
    quantity: 9,
  });

  const craftBefore = heir.skills.craft;
  mentor.action = { type: 'adopt', target: heir.id, kind: 'apprentice', remaining: 1 };
  tick(world);
  assert.equal(mentor.heirId, heir.id);
  assert.equal(heir.mentorId, mentor.id);

  kill(world, mentor, '饿死了。');

  assert.ok(heir.inventory.food >= 5, '食物应该被继承');
  assert.ok(heir.inventory.wood >= 7, '木头应该被继承');
  assert.equal(heir.inventory.weapon, 1, '武器应该被继承');
  assert.equal(heir.knows.fish, true, '知识应该被继承');
  assert.ok(heir.skills.craft > craftBefore, '部分技能应该被继承');
  assert.ok(heir.beliefs.some((b) => b.source === 'inherited'), '信念应该被继承');
  assert.ok(
    heir.beliefs.some((b) => b.proposition.includes('偷了粮食')),
    '被继承的信念内容要保留'
  );
  assert.ok(heir.beliefs.some((b) => b.proposition.includes(mentor.tags.obsession)));
  assert.ok(
    world.facts.some(
      (f) => f.type === 'inherit' && f.subjectId === mentor.id && f.object === heir.id
    )
  );
});

test('关系不够近时，不能收养', () => {
  const world = createWorld(7);
  const mentor = agent(world, '陈默');
  const stranger = agent(world, '阿禾');
  keepOnly(world, [mentor, stranger]);
  mentor.x = 20;
  mentor.y = 20;
  stranger.x = 21;
  stranger.y = 20;
  grass(world, 20, 20);
  grass(world, 21, 20);
  mentor.relationships[stranger.id] = 0;

  mentor.action = { type: 'adopt', target: stranger.id, kind: 'adopted', remaining: 1 };
  tick(world);
  assert.equal(mentor.heirId, null);
});

test('没有继承人时，留下无主遗产和空宅；新来的人可以搬进去', () => {
  const world = createWorld(7);
  const dead = agent(world, '何叔'); // 木匠
  const newcomer = agent(world, '阿禾');
  keepOnly(world, [dead, newcomer]);
  dead.x = 20;
  dead.y = 20;
  dead.inventory = { food: 4, wood: 6, stone: 2, weapon: 0 };
  grass(world, 20, 20);
  grass(world, 21, 20);
  world.structures.push({ type: 'shelter', x: 20, y: 20, name: '何叔的窝棚', ownerId: dead.id, vacant: false });

  kill(world, dead, '饿死了。');

  const remains = world.remains.find((r) => r.x === 20 && r.y === 20);
  assert.ok(remains, '无人继承时应该留下遗产');
  assert.equal(remains.items.food, 4);
  const shelter = world.structures.find((s) => s.type === 'shelter');
  assert.equal(shelter.ownerId, null);

  assert.equal(newcomer.inventory.food, 1);
  newcomer.x = 21;
  newcomer.y = 20;
  newcomer.action = { type: 'moveIn', remaining: 1 };
  tick(world);

  assert.ok(newcomer.inventory.food >= 5, '搬进去应该收下遗产');
  assert.equal(shelter.ownerId, newcomer.id);
  assert.ok(!world.remains.some((r) => r.x === 20 && r.y === 20), '遗产被取走后不该还留在原地');
});

test('没有收养关系的陌生人不会分到遗产', () => {
  const world = createWorld(7);
  const dead = agent(world, '何叔');
  const stranger = agent(world, '阿禾');
  keepOnly(world, [dead, stranger]);
  dead.x = 20;
  dead.y = 20;
  stranger.x = 22;
  stranger.y = 20;
  dead.inventory = { food: 8, wood: 0, stone: 0, weapon: 0 };
  dead.relationships[stranger.id] = 40; // 关系很好，但没有收养

  const before = stranger.inventory.food;
  kill(world, dead, '饿死了。');
  assert.equal(stranger.inventory.food, before);
  assert.ok(world.remains.length > 0);
});

test('养子拿到家当，但不继承手艺里的知识', () => {
  const world = createWorld(7);
  const mentor = agent(world, '陈默');
  const heir = agent(world, '阿禾');
  keepOnly(world, [mentor, heir]);
  mentor.x = 20;
  mentor.y = 20;
  heir.x = 21;
  heir.y = 20;
  grass(world, 20, 20);
  grass(world, 21, 20);
  mentor.relationships[heir.id] = 30;
  mentor.knows.fish = true;
  mentor.action = { type: 'adopt', target: heir.id, kind: 'adopted', remaining: 1 };
  tick(world);

  kill(world, mentor, '饿死了。');
  assert.equal(heir.knows.fish, false, '养子继承家当，不继承“怎么做”');
  assert.ok(heir.beliefs.some((b) => b.source === 'inherited'));
  assert.equal(heir.inheritedFrom, mentor.name);
});

test('祖先的声音只传给已经在关系链里的人', () => {
  const world = createWorld(7);
  const a = agent(world, '阿禾');

  assert.equal(deliverLetter(world, a, '别推那扇门。'), false);
  assert.equal(a.letter, '');
  a.mentorId = 'a1';
  assert.equal(deliverLetter(world, a, '别推那扇门。'), true);
  assert.equal(a.letter, '别推那扇门。');

  const letters = world.eventLog.filter((e) => e.type === 'letter');
  assert.equal(letters[0].payload.heard, false);
  assert.equal(letters[1].payload.heard, true);
});

test('被听见的信需要冷却，冷却结束后才能再写', () => {
  const world = createWorld(7);
  const a = agent(world, '阿禾');
  a.mentorId = 'a1';

  assert.equal(deliverLetter(world, a, '第一封。'), true);
  assert.ok(letterCooldownLeft(world, a) > 0);

  assert.equal(deliverLetter(world, a, '紧接着的第二封。'), false, '冷却中不能再写');
  assert.equal(a.letter, '第一封。');

  world.tick += LETTER_COOLDOWN_TICKS;
  assert.equal(deliverLetter(world, a, '很久以后的第三封。'), true);
  assert.equal(a.letter, '很久以后的第三封。');
});

test('住在别人家里，休息不会更舒服', () => {
  const world = createWorld(7);
  const owner = agent(world, '何叔');
  const stranger = agent(world, '阿禾');
  keepOnly(world, [owner, stranger]);
  owner.x = 20;
  owner.y = 20;
  stranger.x = 20;
  stranger.y = 20;
  world.structures.push({ type: 'shelter', x: 20, y: 20, ownerId: owner.id });
  owner.energy = 50;
  stranger.energy = 50;
  owner.action = { type: 'rest', remaining: 5 };
  stranger.action = { type: 'rest', remaining: 5 };
  tick(world);

  assert.ok(owner.energy > stranger.energy, '屋主才有那个额外的好处');
});

test('规则大脑会搬进无主空宅', () => {
  const world = createWorld(7);
  const a = agent(world, '阿禾');
  keepOnly(world, [a]);
  a.x = 21;
  a.y = 20;
  a.hunger = 80;
  a.energy = 80;
  a.action = null;
  a.cooldownUntil = 0;
  a.deciding = false;
  for (let y = 19; y <= 21; y++) {
    for (let x = 20; x <= 22; x++) grass(world, x, y);
  }
  world.structures.push({ type: 'shelter', x: 20, y: 20, ownerId: null });

  tick(world);
  processBrains(world);
  assert.equal(a.queuedAction?.type, 'moveIn');
});
