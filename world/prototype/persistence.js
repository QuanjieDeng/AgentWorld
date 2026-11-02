// persistence.js — 离线推进与关键事件摘要。
// 事件日志与快照的格式在 engine.js；这里负责“离开这段时间世界做了什么”。

import { tick, MS_PER_TICK, TICKS_PER_DAY } from './engine.js';
import { processBrains } from './brain.js';

const KEY_EVENT_TYPES = new Set([
  'death',
  'build',
  'fight',
  'collapse',
  'fire',
  'letter',
  'institution',
  'turning',
  'fade',
  'migrate',
]);

export function advanceOffline(world, elapsedMs, { maxTicks = TICKS_PER_DAY * 7 } = {}) {
  const fromTick = world.tick;
  const startSeq = world.nextSeq - 1;
  const wanted = Math.max(0, Math.floor(elapsedMs / MS_PER_TICK));
  const ticks = Math.min(wanted, Math.max(0, maxTicks));

  const wasForced = world.forceRule;
  world.forceRule = true;
  try {
    for (let i = 0; i < ticks; i++) {
      tick(world);
      processBrains(world);
    }
  } finally {
    world.forceRule = wasForced;
  }

  const keyEvents = world.eventLog
    .filter((e) => e.seq > startSeq && KEY_EVENT_TYPES.has(e.type))
    .slice(-80);

  return {
    fromTick,
    toTick: world.tick,
    ticks,
    skippedTicks: wanted - ticks,
    keyEvents,
  };
}
