// test-institutions.js — 制度：律法、教义、结社三张固定表；填槽、校验、执行。
// 缝：种子世界 + tick。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, tick, kill, serializeWorld, loadWorld, TILE, W } from './engine.js';

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

function propose(world, a, kind, slots) {
  a.action = { type: 'propose', kind, slots, remaining: 1 };
  tick(world);
}

const lawSlots = (overrides = {}) => ({
  action: 'attack',
  place: 'anywhere',
  subject: 'anyone',
  weapon: 'any',
  reputation: 'any',
  penalty: 'reputation',
  ...overrides,
});

const doctrineSlots = (overrides = {}) => ({
  taboo: 'attack',
  ritual: 'buryDead',
  when: 'always',
  ...overrides,
});

const factionSlots = (overrides = {}) => ({
  name: '火边',
  shared: 'yes',
  joinRequirement: 'trust',
  ...overrides,
});

test('律法只能填固定槽位；合法提案生效，非法提案被驳回', () => {
  const world = createWorld(7);
  const a = agent(world, '阿禾');
  keepOnly(world, [a]);
  a.reputation = 10;

  propose(world, a, 'law', lawSlots());
  assert.equal(world.institutions.length, 1);
  const law = world.institutions[0];
  assert.equal(law.kind, 'law');
  assert.equal(law.active, true);
  assert.equal(law.slots.action, 'attack');

  propose(world, a, 'law', lawSlots({ action: 'dance' }));
  assert.equal(world.institutions.length, 1, '非法槽位不能创建制度');
  assert.ok(
    world.eventLog.some((e) => e.type === 'institution' && e.text.includes('驳回')),
    '驳回要留下记录'
  );
});

test('违反律法会被引擎判定并处罚，事实与目击者信念都留下记录', () => {
  const world = createWorld(7);
  const proposer = agent(world, '周远');
  const attacker = agent(world, '陈默');
  const victim = agent(world, '阿禾');
  const witness = agent(world, '林氏');
  keepOnly(world, [proposer, attacker, victim, witness]);
  place(world, proposer, 10, 10);
  place(world, attacker, 20, 20);
  place(world, victim, 21, 20);
  place(world, witness, 22, 20);
  proposer.reputation = 10;

  propose(world, proposer, 'law', lawSlots());
  const reputationBefore = attacker.reputation;
  attacker.action = { type: 'attack', target: victim.id, remaining: 1 };
  tick(world);

  assert.ok(attacker.reputation < reputationBefore, '违反律法要掉声望');
  assert.ok(world.facts.some((f) => f.type === 'punish' && f.subjectId === attacker.id));
  assert.ok(witness.beliefs.some((b) => b.proposition.includes('触犯')));
});

test('教义会传播给所有活着的人，违反禁忌同样受罚', () => {
  const world = createWorld(7);
  const proposer = agent(world, '周远');
  const attacker = agent(world, '陈默');
  const victim = agent(world, '阿禾');
  keepOnly(world, [proposer, attacker, victim]);
  place(world, proposer, 10, 10);
  place(world, attacker, 20, 20);
  place(world, victim, 21, 20);
  proposer.reputation = 10;

  propose(world, proposer, 'doctrine', doctrineSlots());
  assert.equal(world.institutions.length, 1);
  assert.ok(
    world.agents.filter((a) => a.alive).every((a) => a.beliefs.some((b) => b.source === 'doctrine'))
  );

  const before = attacker.reputation;
  attacker.action = { type: 'attack', target: victim.id, remaining: 1 };
  tick(world);
  assert.ok(attacker.reputation < before, '违反教义禁忌要掉声望');
});

test('结社：创始人当领袖，关系够近的人可以加入，成员共享住处', () => {
  const world = createWorld(7);
  const founder = agent(world, '何叔');
  const member = agent(world, '阿禾');
  const stranger = agent(world, '白姨');
  keepOnly(world, [founder, member, stranger]);
  place(world, founder, 20, 20);
  place(world, member, 20, 20);
  place(world, stranger, 20, 20);
  founder.reputation = 10;

  propose(world, founder, 'faction', factionSlots());
  const faction = world.institutions.find((i) => i.kind === 'faction');
  assert.equal(faction.leaderId, founder.id);
  assert.ok(faction.members.includes(founder.id));

  member.relationships[founder.id] = 20;
  member.action = { type: 'join', faction: faction.id, remaining: 1 };
  tick(world);
  assert.ok(faction.members.includes(member.id));

  world.structures.push({ type: 'shelter', x: 20, y: 20, ownerId: founder.id });
  member.energy = 50;
  stranger.energy = 50;
  member.action = { type: 'rest', remaining: 5 };
  stranger.action = { type: 'rest', remaining: 5 };
  tick(world);
  assert.ok(member.energy > stranger.energy, '结社成员能共享领袖的住处');
});

test('领袖死后，结社由声望最高的成员接手', () => {
  const world = createWorld(7);
  const founder = agent(world, '何叔');
  const member = agent(world, '阿禾');
  keepOnly(world, [founder, member]);
  place(world, founder, 20, 20);
  place(world, member, 21, 20);
  founder.reputation = 30;

  propose(world, founder, 'faction', factionSlots());
  const faction = world.institutions.find((i) => i.kind === 'faction');
  member.relationships[founder.id] = 20;
  member.action = { type: 'join', faction: faction.id, remaining: 1 };
  tick(world);
  member.reputation = 5;

  kill(world, founder, '饿死了。');
  assert.equal(faction.leaderId, member.id);
  assert.equal(faction.active, true);
});

test('解释权由声望最高的解释者决定', () => {
  const world = createWorld(7);
  const proposer = agent(world, '周远');
  const lenient = agent(world, '白姨');
  const strict = agent(world, '石生');
  const attacker = agent(world, '陈默');
  const victim = agent(world, '阿禾');
  keepOnly(world, [proposer, lenient, strict, attacker, victim]);
  place(world, proposer, 10, 10);
  place(world, lenient, 11, 10);
  place(world, strict, 12, 10);
  place(world, attacker, 20, 20);
  place(world, victim, 21, 20);
  proposer.reputation = 10;

  propose(world, proposer, 'law', lawSlots());
  const law = world.institutions[0];

  lenient.reputation = 20;
  lenient.action = { type: 'interpret', institution: law.id, reading: 'lenient', remaining: 1 };
  tick(world);
  attacker.action = { type: 'attack', target: victim.id, remaining: 1 };
  tick(world);
  assert.equal(attacker.reputation, -7, '攻击本身 -2，宽缓解释再扣一半 -5');

  strict.reputation = 30;
  strict.action = { type: 'interpret', institution: law.id, reading: 'strict', remaining: 1 };
  tick(world);
  attacker.reputation = 0;
  victim.hp = 100;
  attacker.action = { type: 'attack', target: victim.id, remaining: 1 };
  tick(world);
  assert.equal(attacker.reputation, -12, '声望更高的解释者改成严格执行');
});

test('槽位缺失的提案会被驳回', () => {
  const world = createWorld(7);
  const a = agent(world, '阿禾');
  keepOnly(world, [a]);
  a.reputation = 10;

  propose(world, a, 'law', { action: 'attack' });
  assert.equal(world.institutions.length, 0);
  assert.ok(world.eventLog.some((e) => e.type === 'institution' && e.text.includes('缺少槽位')));
});

test('律法的持有物条件会改变它是否生效', () => {
  const world = createWorld(7);
  const proposer = agent(world, '周远');
  const attacker = agent(world, '陈默');
  const victim = agent(world, '阿禾');
  keepOnly(world, [proposer, attacker, victim]);
  place(world, proposer, 10, 10);
  place(world, attacker, 20, 20);
  place(world, victim, 21, 20);
  proposer.reputation = 10;
  propose(world, proposer, 'law', lawSlots({ weapon: 'armed' }));

  attacker.inventory.weapon = 0;
  attacker.action = { type: 'attack', target: victim.id, remaining: 1 };
  tick(world);
  assert.equal(attacker.reputation, -2, '空手时律法不适用，只剩攻击本身的 -2');

  attacker.reputation = 0;
  attacker.inventory.weapon = 1;
  victim.hp = 100;
  attacker.action = { type: 'attack', target: victim.id, remaining: 1 };
  tick(world);
  assert.equal(attacker.reputation, -12, '持械时律法生效');
});

test('关系不够的陌生人不能加入结社', () => {
  const world = createWorld(7);
  const founder = agent(world, '何叔');
  const stranger = agent(world, '阿禾');
  keepOnly(world, [founder, stranger]);
  place(world, founder, 20, 20);
  place(world, stranger, 21, 20);
  founder.reputation = 10;

  propose(world, founder, 'faction', factionSlots());
  const faction = world.institutions.find((i) => i.kind === 'faction');
  stranger.relationships[founder.id] = 0;
  stranger.action = { type: 'join', faction: faction.id, remaining: 1 };
  tick(world);

  assert.ok(!faction.members.includes(stranger.id));
});

test('共同财产为否的结社不共享住处', () => {
  const world = createWorld(7);
  const founder = agent(world, '何叔');
  const member = agent(world, '阿禾');
  const stranger = agent(world, '白姨');
  keepOnly(world, [founder, member, stranger]);
  place(world, founder, 20, 20);
  place(world, member, 20, 20);
  place(world, stranger, 20, 20);
  founder.reputation = 10;

  propose(world, founder, 'faction', factionSlots({ shared: 'no' }));
  const faction = world.institutions.find((i) => i.kind === 'faction');
  member.relationships[founder.id] = 20;
  member.action = { type: 'join', faction: faction.id, remaining: 1 };
  tick(world);
  assert.ok(faction.members.includes(member.id));

  world.structures.push({ type: 'shelter', x: 20, y: 20, ownerId: founder.id });
  member.energy = 50;
  stranger.energy = 50;
  member.action = { type: 'rest', remaining: 5 };
  stranger.action = { type: 'rest', remaining: 5 };
  tick(world);
  assert.equal(member.energy, stranger.energy, '非共同财产的结社不共享住处');
});

test('流放由引擎执行：被驱逐的人进不了营地', () => {
  const world = createWorld(7);
  const proposer = agent(world, '周远');
  const attacker = agent(world, '陈默');
  const victim = agent(world, '阿禾');
  keepOnly(world, [proposer, attacker, victim]);
  place(world, proposer, 10, 10);
  place(world, attacker, 20, 20);
  place(world, victim, 21, 20);
  proposer.reputation = 10;

  propose(world, proposer, 'law', lawSlots({ penalty: 'exile' }));
  attacker.action = { type: 'attack', target: victim.id, remaining: 1 };
  tick(world);
  assert.ok(attacker.exiledUntil > world.tick);

  world.structures.push({ type: 'camp', x: 22, y: 20 });
  attacker.x = 21;
  attacker.y = 20;
  attacker.action = { type: 'move', dir: 'E', remaining: 1 };
  tick(world);
  assert.equal(attacker.x, 21, '引擎挡住了回到营地的路');
  assert.ok(attacker.lastAction.includes('驱逐'));
});

test('制度可以存档', () => {
  const world = createWorld(7);
  const a = agent(world, '阿禾');
  keepOnly(world, [a]);
  a.reputation = 10;
  propose(world, a, 'law', lawSlots({ place: 'camp', penalty: 'exile' }));

  const loaded = loadWorld(serializeWorld(world));
  assert.deepEqual(loaded.institutions, world.institutions);
});
