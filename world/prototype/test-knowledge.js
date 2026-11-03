// test-knowledge.js — 知识分层：出身映射、生存常识、后天学习、教与学。
// 缝：种子世界 + tick。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, tick, W, H, TILE, KNOWLEDGE_KEYS } from './engine.js';

function agent(world, name) {
  return world.agents.find((a) => a.name === name);
}

function keepOnly(world, keep) {
  world.agents.forEach((a) => {
    if (!keep.includes(a)) a.alive = false;
  });
}

function shoreSpot(world) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (world.map[y * W + x] !== TILE.WATER) continue;
      const opts = [
        [x, y - 1],
        [x, y + 1],
        [x - 1, y],
        [x + 1, y],
      ].filter(
        ([nx, ny]) => nx >= 0 && ny >= 0 && nx < W && ny < H && world.map[ny * W + nx] !== TILE.WATER
      );
      if (opts.length) return { x: opts[0][0], y: opts[0][1] };
    }
  }
  return null;
}

test('出身决定初始技能：教师会教、农妇会种、铁匠会造、猎人会打', () => {
  const world = createWorld(7);
  const zhou = agent(world, '周远'); // 小城教师
  const lin = agent(world, '林氏'); // 农妇
  const chen = agent(world, '陈默'); // 铁匠
  const qing = agent(world, '阿青'); // 猎人

  assert.ok(zhou.skills.teach > zhou.skills.fight);
  assert.ok(lin.skills.farm > 0);
  assert.ok(chen.skills.craft > zhou.skills.craft);
  assert.ok(qing.skills.fight > chen.skills.fight);
  assert.equal(zhou.knows.craft, false);
});

test('生火是生存常识；搭窝棚、捕鱼、耕种、造武器必须学', () => {
  const world = createWorld(7);
  const he = agent(world, '阿禾'); // 流浪者
  assert.equal(he.knows.fire, true);
  for (const key of KNOWLEDGE_KEYS.filter((k) => k !== 'fire')) {
    assert.equal(he.knows[key], false, `流浪者不该天生会 ${key}`);
  }
});

test('生存常识天生：会采集；但没有对应的知识就建不出窝棚', () => {
  const world = createWorld(7);
  const he = agent(world, '阿禾');
  keepOnly(world, [he]);
  he.x = 20;
  he.y = 20;
  world.map[20 * W + 20] = TILE.GRASS;
  world.map[20 * W + 21] = TILE.BUSH;
  he.inventory.food = 1;
  he.inventory.wood = 20;
  he.hunger = 20;
  he.skills.gather = 1;

  he.action = { type: 'gather', remaining: 1 };
  const foodBefore = he.inventory.food;
  tick(world);
  assert.ok(he.inventory.food > foodBefore, '采集是生存常识');
  assert.ok(he.skills.gather > 1, '采集会让采集技能成长');

  he.action = { type: 'build', build: 'shelter', remaining: 1 };
  tick(world);
  assert.ok(!world.structures.some((s) => s.type === 'shelter'), '不会搭窝棚就不该建出来');
});

test('有知识的木匠能搭窝棚', () => {
  const world = createWorld(7);
  const he = agent(world, '何叔'); // 木匠
  keepOnly(world, [he]);
  he.x = 20;
  he.y = 20;
  world.map[20 * W + 20] = TILE.GRASS;
  he.inventory.wood = 20;

  he.action = { type: 'build', build: 'shelter', remaining: 1 };
  tick(world);
  assert.ok(world.structures.some((s) => s.type === 'shelter'));
});

test('教知识需要多节课，学的人按禀赋获得进度', () => {
  const world = createWorld(7);
  const teacher = agent(world, '陈默'); // 铁匠，会造武器
  const artisan = agent(world, '何叔'); // 手艺，学得快；原本会造武器，先清掉
  const quick = agent(world, '阿禾'); // 机敏，学得慢
  keepOnly(world, [teacher, artisan, quick]);
  teacher.x = 20;
  teacher.y = 20;
  artisan.x = 21;
  artisan.y = 20;
  quick.x = 20;
  quick.y = 21;
  world.map[20 * W + 20] = TILE.GRASS;
  world.map[20 * W + 21] = TILE.GRASS;
  world.map[21 * W + 20] = TILE.GRASS;
  artisan.knows.craft = false;
  artisan.learning = {};

  const energyBefore = teacher.energy;
  teacher.action = { type: 'teach', target: quick.id, skill: 'craft', remaining: 1 };
  tick(world);
  assert.equal(quick.knows.craft, false, '一节课教不会');
  assert.ok(quick.learning.craft > 0 && quick.learning.craft < 1);

  // 手艺的人两节课学会，机敏的人要三节。
  for (let i = 0; i < 2; i++) {
    teacher.action = { type: 'teach', target: artisan.id, skill: 'craft', remaining: 1 };
    tick(world);
  }
  assert.equal(artisan.knows.craft, true);

  for (let i = 0; i < 2; i++) {
    teacher.action = { type: 'teach', target: quick.id, skill: 'craft', remaining: 1 };
    tick(world);
  }
  assert.equal(quick.knows.craft, true);
  assert.ok(energyBefore - teacher.energy > 5, '教的人要付出体力');

  assert.ok(
    world.facts.some((f) => f.type === 'teach' && f.subjectId === teacher.id && f.object === 'craft')
  );
  assert.ok(artisan.beliefs.some((b) => b.source === 'taught'));

  quick.inventory.wood = 5;
  quick.action = { type: 'craft', remaining: 1 };
  tick(world);
  assert.equal(quick.inventory.weapon, 1, '学会之后就能造出武器');
});

test('做同一件事，禀赋高的人成长更快', () => {
  const world = createWorld(7);
  const strong = agent(world, '陈默'); // 体魄：采集 1.2
  const talker = agent(world, '白姨'); // 口才：采集 1.0
  keepOnly(world, [strong, talker]);
  strong.x = 10;
  strong.y = 10;
  talker.x = 30;
  talker.y = 30;
  for (const a of [strong, talker]) {
    a.skills.gather = 1;
    a.hunger = 80;
    a.energy = 80;
  }

  for (let i = 0; i < 10; i++) {
    for (const [a, bx, by] of [
      [strong, 10, 10],
      [talker, 30, 30],
    ]) {
      world.map[by * W + bx] = TILE.GRASS;
      world.map[(by - 1) * W + bx] = TILE.GRASS;
      world.map[(by + 1) * W + bx] = TILE.GRASS;
      world.map[by * W + (bx - 1)] = TILE.GRASS;
      world.map[by * W + (bx + 1)] = TILE.BUSH;
      a.action = { type: 'gather', remaining: 1 };
    }
    tick(world);
  }

  assert.ok(strong.skills.gather > talker.skills.gather);
});

test('不会捕鱼的人在岸边也捕不到鱼；渔夫能', () => {
  function fishFood(name) {
    const world = createWorld(7);
    const a = agent(world, name);
    keepOnly(world, [a]);
    const spot = shoreSpot(world);
    assert.ok(spot, '地图上应该有岸边');
    a.x = spot.x;
    a.y = spot.y;
    a.inventory.food = 0;
    for (let i = 0; i < 40; i++) {
      a.action = { type: 'fish', remaining: 1 };
      tick(world);
    }
    return a.inventory.food;
  }

  assert.equal(fishFood('阿禾'), 0);
  assert.ok(fishFood('老唐') > 0);
});
