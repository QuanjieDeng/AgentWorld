// test-chronicle.js — 编年史叙事层：事实层只读，叙事按观看者 + 事件段缓存。
// 缝 3：narrate(world, viewerId, range, narrator)，narrator 注入。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorld,
  applyTurning,
  logEvent,
  snapshot,
  serializeWorld,
  TICKS_PER_DAY,
} from './engine.js';
import {
  narrate,
  collectChronicleFacts,
  daySummaries,
  defaultNarrator,
  digestOf,
} from './chronicle.js';

function agent(world, name) {
  return world.agents.find((a) => a.name === name);
}

function factsHash(world) {
  return JSON.stringify({ facts: world.facts, eventLog: world.eventLog });
}

function turn(world, name, trigger = 'killed') {
  const a = agent(world, name);
  return applyTurning(world, a, trigger, '手上带血的人', '你活了下来。');
}

test('编年史只收关键事件，不收日常交谈', () => {
  const world = createWorld(11);
  turn(world, '阿禾');
  logEvent(world, 'talk', '阿禾对白姨说：「今天风很大。」', agent(world, '阿禾').id);

  const entries = collectChronicleFacts(world, { fromDay: 1, toDay: 1 });
  assert.ok(entries.some((e) => e.type === 'turning'));
  assert.ok(!entries.some((e) => e.type === 'talk'), '日常交谈不属于编年史');
});

test('编年史条目带有范围、涉及的人、地点与结果', () => {
  const world = createWorld(11);
  turn(world, '阿禾');

  const [entry] = collectChronicleFacts(world, { fromDay: 1, toDay: 1 });
  assert.equal(entry.day, 1);
  assert.ok(entry.t >= 0);
  assert.deepEqual(
    entry.people.map((p) => p.name),
    ['阿禾']
  );
  assert.equal(entry.place, '空地');
  assert.equal(entry.result, '手上带血的人');
  assert.equal(entry.type, 'turning');
});

test('默认叙事器把事实读成文字，空段也会说明', async () => {
  const world = createWorld(11);
  turn(world, '阿禾');

  const result = await narrate(world, 'viewer-a', { fromDay: 1, toDay: 1 });
  assert.ok(result.narrative.includes('阿禾'));
  assert.ok(result.narrative.includes('第 1 天'));
  assert.equal(result.cached, false);

  const empty = await narrate(world, 'viewer-a', { fromDay: 9, toDay: 9 });
  assert.ok(empty.narrative.includes('没有值得记下的事'));
});

test('同一观看者 + 同一事件段，第二次不再调用叙事器', async () => {
  const world = createWorld(11);
  turn(world, '阿禾');

  let calls = 0;
  const narrator = () => {
    calls++;
    return `第 ${calls} 版`;
  };
  const first = await narrate(world, 'viewer-a', { fromDay: 1, toDay: 1 }, narrator);
  const second = await narrate(world, 'viewer-a', { fromDay: 1, toDay: 1 }, narrator);

  assert.equal(calls, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.narrative, '第 1 版');
});

test('观看者 A 的叙事不写进观看者 B 的缓存', async () => {
  const world = createWorld(11);
  turn(world, '阿禾');

  let calls = 0;
  const narrator = (ctx) => {
    calls++;
    return `${ctx.viewerId} 的第 ${calls} 版`;
  };
  const a = await narrate(world, 'viewer-a', { fromDay: 1, toDay: 1 }, narrator);
  const b = await narrate(world, 'viewer-b', { fromDay: 1, toDay: 1 }, narrator);
  const aAgain = await narrate(world, 'viewer-a', { fromDay: 1, toDay: 1 }, narrator);

  assert.equal(a.narrative, 'viewer-a 的第 1 版');
  assert.equal(b.narrative, 'viewer-b 的第 2 版');
  assert.equal(aAgain.narrative, a.narrative);
  assert.equal(calls, 2, '两个观看者各生成一次，A 第二次走缓存');
  assert.equal(aAgain.cached, true);
});

test('换一个叙事器，同一段事实会得到不同的文字，事实层不动', async () => {
  const world = createWorld(11);
  turn(world, '阿禾');
  const before = factsHash(world);

  const one = await narrate(world, 'viewer-a', { fromDay: 1, toDay: 1 }, () => '一场悲剧。', {
    cache: false,
  });
  const two = await narrate(world, 'viewer-a', { fromDay: 1, toDay: 1 }, () => '一次背叛。', {
    cache: false,
  });

  assert.notEqual(one.narrative, two.narrative);
  assert.equal(factsHash(world), before, '叙事前后事实层与事件日志逐字节一致');
});

test('生成叙事不会改动世界，缓存也不进存档', async () => {
  const world = createWorld(11);
  turn(world, '阿禾');
  const before = JSON.stringify(serializeWorld(world));

  await narrate(world, 'viewer-a', { fromDay: 1, toDay: 1 }, () => '我的版本。');

  assert.equal(JSON.stringify(serializeWorld(world)), before);
  const saved = serializeWorld(world);
  assert.ok(!('narrationCache' in saved));
  assert.ok(!('narrative' in saved));
});

test('事件段按世界日切分，段外的事件不会混进来', async () => {
  const world = createWorld(11);
  turn(world, '阿禾');

  world.day = 2;
  world.tick = TICKS_PER_DAY + 100;
  turn(world, '白姨', 'enemy_died');

  const day1 = collectChronicleFacts(world, { fromDay: 1, toDay: 1 });
  const day2 = collectChronicleFacts(world, { fromDay: 2, toDay: 2 });

  assert.equal(day1.length, 1);
  assert.equal(day2.length, 1);
  assert.equal(day1[0].people[0].name, '阿禾');
  assert.equal(day2[0].people[0].name, '白姨');
});

test('时间轴摘要按天统计关键事件', () => {
  const world = createWorld(11);
  turn(world, '阿禾');
  logEvent(world, 'talk', '一句日常的话。', agent(world, '阿禾').id);

  world.day = 2;
  world.tick = TICKS_PER_DAY + 100;
  turn(world, '白姨', 'enemy_died');

  const days = daySummaries(world);
  assert.equal(days.length, 2);
  assert.equal(days[0].day, 1);
  assert.equal(days[0].turnings, 1);
  assert.equal(days[0].total, 1);
  assert.equal(days[1].total, 1);
});

test('观看者如果是岛上的居民，叙事上下文里带着他自己的信念', async () => {
  const world = createWorld(11);
  const a = agent(world, '阿禾');
  a.beliefs.push({ id: 'b1', proposition: '白姨偷了你的食物。', source: 'hearsay', confidence: 0.6 });

  let seen = null;
  await narrate(world, a.id, { fromDay: 1, toDay: 1 }, (ctx) => {
    seen = ctx;
    return '...';
  }, { cache: false });

  assert.equal(seen.viewer.kind, 'resident');
  assert.equal(seen.viewer.name, '阿禾');
  assert.ok(seen.viewer.beliefs.some((b) => b.proposition.includes('白姨')));
});

test('观看者状态带上界面 v1 需要的字段', () => {
  const world = createWorld(11);
  const a = agent(world, '阿禾');
  a.mentorId = 'a2';
  a.heirId = 'a3';
  a.heirKind = 'adopted';
  a.identity = '猎手';

  const s = snapshot(world);
  const sa = s.agents.find((x) => x.id === a.id);
  assert.equal(sa.mentorId, 'a2');
  assert.equal(sa.heirId, 'a3');
  assert.equal(sa.heirKind, 'adopted');
  assert.equal(sa.identity, '猎手');
  assert.ok('letterCooldownLeft' in sa);
  assert.ok('relationships' in sa);
  assert.ok(s.labels.languages.north);
  assert.ok(s.labels.knowledge.fire);
  assert.ok(Array.isArray(s.chronicle));
});

test('摘要与事件段互不依赖：两条路径看到同一批事实', () => {
  const world = createWorld(11);
  turn(world, '阿禾');

  const entries = collectChronicleFacts(world, { fromDay: 1, toDay: 1 });
  assert.equal(digestOf(entries), digestOf(entries));
  assert.equal(daySummaries(world)[0].total, entries.length);
});
