// test-belief.js — 实验开关：规则大脑按“自己的信念”判断威胁，而不是全知的世界状态。
// 默认关闭；BELIEF_RULES=1 时才生效，决策仍然写进日志，所以重放不受影响。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, tick, TILE, W } from './engine.js';
import { mockDecide, processBrains } from './brain.js';
import { exportJournal, rebuildFromJournal, stateHash } from './sync.js';

function place(world, agent, x, y) {
  agent.x = x;
  agent.y = y;
  world.map[y * W + x] = TILE.GRASS;
}

function setup({ beliefDrivenRules }) {
  const world = createWorld(7);
  world.config.beliefDrivenRules = beliefDrivenRules;
  const victim = world.agents[0];
  const attacker = world.agents[1];
  place(world, victim, 18, 18);
  place(world, attacker, 19, 18);
  victim.hunger = 80;
  victim.energy = 100;
  victim.hp = 100;
  victim.skills.fight = 5;
  victim.relationships[attacker.id] = 0;
  victim.beliefs.push({
    id: 'test-belief',
    t: world.tick,
    proposition: `${attacker.name}攻击了你。`,
    source: 'victim',
    confidence: 1,
    claim: {
      kind: 'fight',
      subjectId: attacker.id,
      predicate: 'hit',
      targetId: victim.id,
    },
  });
  return { world, victim, attacker };
}

test('开关关闭时，信念里的攻击者不会触发敌对判断', () => {
  const { world, victim, attacker } = setup({ beliefDrivenRules: false });
  const action = mockDecide(world, victim);
  assert.notEqual(action?.type, 'attack');
});

test('开关打开时，被自己相信攻击过自己的人会触发敌对判断', () => {
  const { world, victim, attacker } = setup({ beliefDrivenRules: true });
  const action = mockDecide(world, victim);
  assert.equal(action?.type, 'attack');
  assert.equal(action?.target, attacker.id);
});

test('开关打开后，世界仍然可以逐字节重放', () => {
  // 手工塞进去的信念没有对应事件，不能拿来比重放；这里只验证开关本身
  // 不影响日志/状态的可重放性（决策仍然写进 decision 事件）。
  const world = createWorld(7);
  world.config.beliefDrivenRules = true;
  for (let i = 0; i < 12; i++) {
    tick(world);
    processBrains(world);
  }
  const journal = exportJournal(world);
  const rebuilt = rebuildFromJournal(journal);
  assert.equal(stateHash(rebuilt), stateHash(world));
});
