// test-turning.js — 脱变：引擎判定转折，受控词表给标签，一生 2–5 次，写进编年史。
// 缝：种子世界 + tick。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorld,
  tick,
  kill,
  applyTurning,
  serializeWorld,
  loadWorld,
  TURNING_TRIGGERS,
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

test('仇人死亡会触发脱变，标签来自受控词表', () => {
  const world = createWorld(7);
  const hater = agent(world, '阿禾');
  const victim = agent(world, '陈默');
  keepOnly(world, [hater, victim]);
  place(world, hater, 20, 20);
  place(world, victim, 21, 20);
  hater.relationships[victim.id] = -30;

  kill(world, victim, '饿死了。');

  assert.equal(hater.turningPoints.length, 1);
  const turning = hater.turningPoints[0];
  assert.equal(turning.trigger, 'enemy_died');
  assert.ok(TURNING_TRIGGERS.enemy_died.labels.includes(turning.label));
  assert.equal(hater.identity, turning.label);
  assert.ok(hater.reputation >= 5);
  assert.ok(world.facts.some((f) => f.type === 'turning' && f.subjectId === hater.id));
  assert.ok(world.chronicle.some((c) => c.kind === 'turning' && c.agentId === hater.id));
});

test('亲手杀人会脱变', () => {
  const world = createWorld(7);
  const killer = agent(world, '陈默');
  const victim = agent(world, '阿禾');
  keepOnly(world, [killer, victim]);

  kill(world, victim, '死在陈默手里。', killer.id);

  assert.equal(killer.turningPoints[0].trigger, 'killed');
  assert.ok(TURNING_TRIGGERS.killed.labels.includes(killer.turningPoints[0].label));
});

test('收养的人死了会脱变', () => {
  const world = createWorld(7);
  const mentor = agent(world, '陈默');
  const heir = agent(world, '阿禾');
  keepOnly(world, [mentor, heir]);
  place(world, mentor, 20, 20);
  place(world, heir, 21, 20);
  mentor.relationships[heir.id] = 30;
  mentor.action = { type: 'adopt', target: heir.id, kind: 'apprentice', remaining: 1 };
  tick(world);

  kill(world, mentor, '饿死了。');
  assert.equal(heir.turningPoints.length, 0, '只是看见死亡还不算埋葬');

  heir.action = { type: 'bury', remaining: 1 };
  tick(world);

  assert.equal(heir.turningPoints[0].trigger, 'kin_died');
  assert.ok(TURNING_TRIGGERS.kin_died.labels.includes(heir.turningPoints[0].label));
});

test('被信任的人攻击会脱变', () => {
  const world = createWorld(7);
  const attacker = agent(world, '陈默');
  const target = agent(world, '阿禾');
  keepOnly(world, [attacker, target]);
  place(world, attacker, 20, 20);
  place(world, target, 21, 20);
  target.relationships[attacker.id] = 30;
  target.hp = 100;

  attacker.action = { type: 'attack', target: target.id, remaining: 1 };
  tick(world);

  assert.equal(target.turningPoints[0].trigger, 'betrayed');
  assert.ok(TURNING_TRIGGERS.betrayed.labels.includes(target.turningPoints[0].label));
});

test('被别人当成主心骨时，才会成为首领', () => {
  const world = createWorld(7);
  const leader = agent(world, '阿禾');
  const follower = agent(world, '白姨');
  keepOnly(world, [leader, follower]);
  place(world, leader, 20, 20);
  place(world, follower, 21, 20);
  leader.reputation = 10;
  follower.relationships[leader.id] = 20;

  follower.action = { type: 'talk', target: leader.id, say: '你说怎么办。', remaining: 1 };
  tick(world);

  assert.equal(leader.turningPoints[0].trigger, 'leader');
});

test('“手上带血的人”更敢动手', () => {
  function decide(identity) {
    const world = createWorld(7);
    const a = agent(world, '阿禾');
    const enemy = agent(world, '陈默');
    keepOnly(world, [a, enemy]);
    place(world, a, 20, 20);
    place(world, enemy, 21, 20);
    a.relationships[enemy.id] = -30;
    a.identity = identity;
    a.hp = 40;
    a.skills.fight = 3;
    a.hunger = 80;
    a.energy = 80;
    a.action = null;
    a.cooldownUntil = 0;
    a.deciding = false;

    tick(world);
    processBrains(world);
    return a.queuedAction?.type;
  }

  assert.equal(decide('手上带血的人'), 'attack');
  assert.equal(decide(null), 'flee');
});

test('受控词表之外的标签会被引擎替换', () => {
  const world = createWorld(7);
  const a = agent(world, '阿禾');
  const turning = applyTurning(world, a, 'enemy_died', '胡编的标签', '测试。');
  assert.ok(TURNING_TRIGGERS.enemy_died.labels.includes(turning.label));
});

test('身份、脱变记录和编年史可以存档', () => {
  const world = createWorld(7);
  const a = agent(world, '阿禾');
  applyTurning(world, a, 'enemy_died', TURNING_TRIGGERS.enemy_died.labels[0], '测试。');

  const loaded = loadWorld(serializeWorld(world));
  const b = loaded.agents.find((x) => x.id === a.id);
  assert.equal(b.identity, a.identity);
  assert.deepEqual(b.turningPoints, a.turningPoints);
  assert.deepEqual(loaded.chronicle, world.chronicle);
});

test('一生最多 2–5 次脱变，达到上限后不再触发', () => {
  const world = createWorld(7);
  const a = agent(world, '阿禾');
  assert.ok(a.maxTurnings >= 2 && a.maxTurnings <= 5);
  a.maxTurnings = 1;

  const first = agent(world, '陈默');
  const second = agent(world, '白姨');
  keepOnly(world, [a, first, second]);
  place(world, a, 20, 20);
  place(world, first, 21, 20);
  place(world, second, 30, 30);
  a.relationships[first.id] = -30;
  a.relationships[second.id] = -30;

  kill(world, first, '饿死了。');
  kill(world, second, '饿死了。', a.id);

  assert.equal(a.turningPoints.length, 1);
});

test('同样的世界，脱变标签可复现', () => {
  function run() {
    const world = createWorld(7);
    const hater = agent(world, '阿禾');
    const victim = agent(world, '陈默');
    keepOnly(world, [hater, victim]);
    place(world, hater, 20, 20);
    place(world, victim, 21, 20);
    hater.relationships[victim.id] = -30;
    kill(world, victim, '饿死了。');
    return hater.turningPoints[0];
  }
  assert.deepEqual(run(), run());
});

test('死前不足 2 次脱变的人会完成临终脱变', () => {
  const world = createWorld(7);
  const a = world.agents[0];
  a.turningPoints = [];
  a.maxTurnings = 5;
  kill(world, a, '死于测试');
  assert.equal(a.turningPoints.length, 2);
  assert.equal(a.turningPoints[0].trigger, 'last_days');
  assert.equal(a.turningPoints[1].trigger, 'deathbed');
  assert.equal(a.identity, a.turningPoints[1].label);

  // 已经够 2 次的人不会再补。
  const b = world.agents[1];
  b.turningPoints = [
    { trigger: 'killed', label: '幸存者' },
    { trigger: 'leader', label: '首领' },
  ];
  const before = b.turningPoints.length;
  kill(world, b, '死于测试');
  assert.equal(b.turningPoints.length, before);
});
