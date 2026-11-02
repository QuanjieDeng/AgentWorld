// persistence.js — 离线推进、关键事件摘要、从决策日志重建世界。
// 事件日志与快照的格式在 engine.js；这里负责“离开这段时间世界做了什么”。

import { createWorld, tick, replayDecisions, MS_PER_TICK, TICKS_PER_DAY } from './engine.js';
import { processBrains } from './brain.js';

const KEY_EVENT_TYPES = new Set(['death', 'build', 'fight', 'collapse', 'fire', 'letter']);

export function stepWorld(world, ticks) {
  for (let i = 0; i < ticks; i++) {
    tick(world);
    processBrains(world);
  }
}

export function advanceOffline(world, elapsedMs, { maxTicks = TICKS_PER_DAY * 7 } = {}) {
  const fromTick = world.tick;
  const startSeq = world.nextSeq - 1;
  const wanted = Math.max(0, Math.floor(elapsedMs / MS_PER_TICK));
  const ticks = Math.min(wanted, Math.max(0, maxTicks));
  const before = new Map(
    world.agents.filter((a) => a.alive).map((a) => [a.id, { x: a.x, y: a.y }])
  );

  const wasForced = world.ruleOnly;
  world.ruleOnly = true;
  try {
    stepWorld(world, ticks);
  } finally {
    world.ruleOnly = wasForced;
  }

  const keyEvents = world.eventLog
    .filter((e) => e.seq > startSeq && KEY_EVENT_TYPES.has(e.type))
    .slice(-80);

  const alive = world.agents.filter((a) => a.alive);
  const stillAlive = alive.map((a) => a.id);
  const gone = [...before.keys()].filter((id) => !stillAlive.includes(id));
  const moved = alive
    .filter((a) => {
      const was = before.get(a.id);
      return was && (was.x !== a.x || was.y !== a.y);
    })
    .map((a) => ({ id: a.id, from: before.get(a.id), to: { x: a.x, y: a.y } }));

  return {
    fromTick,
    toTick: world.tick,
    ticks,
    skippedTicks: wanted - ticks,
    keyEvents,
    stillAlive,
    gone,
    moved,
  };
}

export function rebuildWorld({ seed, decisions = [], tick: targetTick }) {
  const world = createWorld(seed);
  replayDecisions(world, decisions.filter((d) => d.tick <= targetTick));
  while (world.tick < targetTick) stepWorld(world, 1);
  return world;
}
