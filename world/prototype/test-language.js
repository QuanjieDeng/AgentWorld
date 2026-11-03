// test-language.js — 语言墙：组内互通，组间听不懂，只能靠学习与教学打通。
// 缝：种子世界 + tick。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, tick, serializeWorld, loadWorld, LANGUAGE_KEYS, LANGUAGE_LABEL, TILE, W } from './engine.js';

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

test('十二个人分成 2–4 种语言，每种 3–6 个母语者', () => {
  const world = createWorld(7);
  const counts = {};
  for (const a of world.agents) counts[a.nativeLanguage] = (counts[a.nativeLanguage] || 0) + 1;
  const languages = Object.keys(counts);
  assert.ok(languages.length >= 2 && languages.length <= 4);
  for (const lang of languages) {
    assert.ok(counts[lang] >= 3 && counts[lang] <= 6);
    assert.ok(LANGUAGE_KEYS.includes(lang));
    assert.ok(LANGUAGE_LABEL[lang]);
  }
  for (const a of world.agents) assert.ok(a.tags.hometown);

  const zhou = agent(world, '周远');
  assert.equal(zhou.tags.hometown, '北岸');
  assert.equal(zhou.nativeLanguage, 'north');
});

test('同一种语言的人能听懂彼此，交谈内容进入信念', () => {
  const world = createWorld(7);
  const speaker = agent(world, '周远'); // 北岸话
  const listener = agent(world, '林氏'); // 北岸话
  keepOnly(world, [speaker, listener]);
  place(world, speaker, 20, 20);
  place(world, listener, 21, 20);

  speaker.action = { type: 'talk', target: listener.id, say: '今晚别出门。', remaining: 1 };
  tick(world);

  assert.ok(listener.beliefs.some((b) => b.proposition.includes('今晚别出门')));
  const event = world.eventLog.filter((e) => e.type === 'talk').at(-1);
  assert.equal(event.payload.understood, true);
});

test('不同语言的人听不懂内容，但观看者仍然看得到原话', () => {
  const world = createWorld(7);
  const speaker = agent(world, '周远'); // 北岸话
  const listener = agent(world, '老唐'); // 南渡话
  keepOnly(world, [speaker, listener]);
  place(world, speaker, 20, 20);
  place(world, listener, 21, 20);

  speaker.action = { type: 'talk', target: listener.id, say: '粮仓在坡后面。', remaining: 1 };
  tick(world);

  assert.ok(!listener.beliefs.some((b) => b.proposition.includes('粮仓在坡后面')));
  const event = world.eventLog.filter((e) => e.type === 'talk').at(-1);
  assert.equal(event.payload.understood, false);
  assert.ok(event.text.includes('粮仓在坡后面'), '观看者永远看得懂');
});

test('长期共处能学会对方的语言；学会之后就能听懂', () => {
  const world = createWorld(7);
  const speaker = agent(world, '周远'); // 北岸话
  const listener = agent(world, '老唐'); // 南渡话
  keepOnly(world, [speaker, listener]);
  place(world, speaker, 20, 20);
  place(world, listener, 21, 20);
  listener.languageProgress = { [speaker.nativeLanguage]: 0.9999 };

  // 不说话，只是待在一起。
  tick(world);
  assert.equal(listener.languages[speaker.nativeLanguage], true, '待在一起就会慢慢学会');

  speaker.action = { type: 'talk', target: listener.id, say: '这边走。', remaining: 1 };
  tick(world);
  assert.ok(listener.beliefs.some((b) => b.proposition.includes('这边走')));
});

test('听不懂的交谈仍然发出声音，但声音里没有名字', () => {
  const world = createWorld(7);
  const speaker = agent(world, '周远');
  const listener = agent(world, '老唐');
  keepOnly(world, [speaker, listener]);
  place(world, speaker, 20, 20);
  place(world, listener, 21, 20);

  speaker.action = { type: 'talk', target: listener.id, say: '粮仓在坡后面。', remaining: 1 };
  tick(world);

  const sound = world.sounds.find((s) => s.kind === 'talk');
  assert.ok(sound, '听不懂也应该有声音');
  assert.ok(!sound.text.includes(speaker.name), '声音里不能带名字');
  assert.ok(sound.radius > 0);
});

test('会两种语言的人可以当桥梁', () => {
  const world = createWorld(7);
  const speaker = agent(world, '周远'); // 北岸话
  const listener = agent(world, '老唐'); // 南渡话
  keepOnly(world, [speaker, listener]);
  place(world, speaker, 20, 20);
  place(world, listener, 21, 20);
  speaker.languages[listener.nativeLanguage] = true;

  speaker.action = { type: 'talk', target: listener.id, say: '我们一起走。', remaining: 1 };
  tick(world);

  assert.ok(listener.beliefs.some((b) => b.proposition.includes('我们一起走')));
});

test('教一门语言需要多节课，最后会真的学会', () => {
  const world = createWorld(7);
  const teacher = agent(world, '林氏'); // 北岸话
  const student = agent(world, '老唐'); // 南渡话
  keepOnly(world, [teacher, student]);
  place(world, teacher, 20, 20);
  place(world, student, 21, 20);

  for (let i = 0; i < 4 && !student.languages[teacher.nativeLanguage]; i++) {
    teacher.action = { type: 'teach', target: student.id, skill: teacher.nativeLanguage, remaining: 1 };
    tick(world);
  }
  assert.equal(student.languages[teacher.nativeLanguage], true);
  assert.ok(world.facts.some((f) => f.type === 'teach' && f.object === teacher.nativeLanguage));
});

test('语言与学习进度可以存档', () => {
  const world = createWorld(7);
  const a = agent(world, '老唐');
  a.languages.north = true;
  a.languageProgress.outland = 0.4;

  const loaded = loadWorld(serializeWorld(world));
  const b = loaded.agents.find((x) => x.id === a.id);
  assert.deepEqual(b.languages, a.languages);
  assert.deepEqual(b.languageProgress, a.languageProgress);
});
