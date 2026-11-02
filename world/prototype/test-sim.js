// test-sim.js — 不启动网页，直接让世界跑几天，看看它会不会自己长出东西。
// 用法：node test-sim.js

import { createWorld, tick } from './engine.js';
import { processBrains } from './brain.js';

const TICKS = 3600; // 2.5 个世界日

for (const seed of [1, 2, 3, 42, 20261102]) {
  const world = createWorld(seed);
  for (let i = 0; i < TICKS; i++) {
    tick(world);
    processBrains(world);
  }

  const alive = world.agents.filter((a) => a.alive);
  const deaths = world.log.filter((e) => e.type === 'death');
  const builds = world.log.filter((e) => e.type === 'build');
  const talks = world.log.filter((e) => e.type === 'talk');
  const fights = world.log.filter((e) => e.type === 'fight');
  const wolfEvents = world.log.filter((e) => e.type === 'wolf');
  const fires = world.structures.filter((s) => s.type === 'fire');
  const fireBuilds = builds.filter((b) => b.text.includes('火堆'));

  console.log(`\nseed ${seed}`);
  console.log(`  活着 ${alive.length}/12 · 死亡 ${deaths.length} · 建筑 ${builds.length}（火 ${fireBuilds.length}） · 交谈 ${talks.length} · 战斗 ${fights.length} · 野兽事件 ${wolfEvents.length}`);
  console.log(`  当前火堆 ${fires.length} · 窝棚 ${world.structures.filter((s) => s.type === 'shelter').length} · 坟 ${world.structures.filter((s) => s.type === 'grave').length}`);
  if (deaths.length) console.log('  死因:', deaths.map((d) => d.text).join(' | '));
  if (builds.length) console.log('  建造:', builds.slice(0, 6).map((d) => `${d.day}日${d.clock} ${d.text}`).join(' | '));
  if (fights.length) console.log('  冲突:', fights.slice(0, 6).map((d) => `${d.day}日${d.clock} ${d.text}`).join(' | '));
}
