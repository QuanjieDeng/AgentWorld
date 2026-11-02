// perception.js — 看见的、听见的、和不知道的。
// 视野：朝向 + 120° 锥形，白天 6 格、夜里 3 格，树/岩石/墙遮挡。
// 听：事件发声，能穿墙，但只给方向和模糊距离，不给名字。

import { W, H, TILE } from './engine.js';

const DIR_VEC = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] };
const COMPASS = ['东', '东南', '南', '西南', '西', '西北', '北', '东北'];

export function visionRange(world) {
  return world.isNight ? 3 : 6;
}

export function blocksSight(world, x, y) {
  if (x < 0 || y < 0 || x >= W || y >= H) return true;
  const t = world.map[y * W + x];
  if (t === TILE.TREE || t === TILE.ROCK) return true;
  return world.structures.some((s) => s.type === 'wall' && s.x === x && s.y === y);
}

function lineClear(world, x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  let guard = 0;

  while (!(x === x1 && y === y1)) {
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
    if (x === x1 && y === y1) return true;
    if (blocksSight(world, x, y)) return false;
    if (++guard > 100) return false;
  }
  return true;
}

export function compass(a, x, y) {
  const dx = x - a.x;
  const dy = y - a.y;
  if (dx === 0 && dy === 0) return '身边';
  const ang = Math.atan2(dy, dx);
  const idx = Math.round(((ang + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return COMPASS[idx];
}

export function canSee(world, a, x, y) {
  const range = visionRange(world);
  const dx = x - a.x;
  const dy = y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist > range) return false;

  // 贴得很近的人，不用面对也看得见
  if (dist <= 1.5) return lineClear(world, a.x, a.y, x, y);

  const f = DIR_VEC[a.facing] || DIR_VEC.S;
  const dot = (dx / dist) * f[0] + (dy / dist) * f[1];
  if (dot < 0.5) return false; // 120° 视野
  return lineClear(world, a.x, a.y, x, y);
}

export function visibleAgents(world, a) {
  return world.agents
    .filter((o) => o.alive && o.id !== a.id && canSee(world, a, o.x, o.y))
    .map((o) => ({
      agent: o,
      dist: Math.round(Math.hypot(o.x - a.x, o.y - a.y)),
      dir: compass(a, o.x, o.y),
    }))
    .sort((p, q) => p.dist - q.dist);
}

export function visibleStructures(world, a) {
  return world.structures
    .filter((s) => canSee(world, a, s.x, s.y))
    .map((s) => ({
      structure: s,
      dist: Math.round(Math.hypot(s.x - a.x, s.y - a.y)),
      dir: compass(a, s.x, s.y),
    }))
    .sort((p, q) => p.dist - q.dist);
}

export function visibleWolves(world, a) {
  return world.wolves
    .filter((w) => canSee(world, a, w.x, w.y))
    .map((w) => ({
      wolf: w,
      dist: Math.round(Math.hypot(w.x - a.x, w.y - a.y)),
      dir: compass(a, w.x, w.y),
    }))
    .sort((p, q) => p.dist - q.dist);
}

export function distanceBand(d) {
  if (d <= 3) return '很近';
  if (d <= 8) return '不远处';
  return '远处';
}

export function heardSounds(world, a) {
  const seen = new Set();
  return world.sounds
    .filter((s) => world.tick - s.tick <= 8)
    .filter((s) => s.sourceId !== a.id)
    .map((s) => ({ sound: s, dist: Math.hypot(s.x - a.x, s.y - a.y) }))
    .filter(({ sound, dist }) => dist <= sound.radius)
    .filter(({ sound }) => !canSee(world, a, sound.x, sound.y))
    .filter(({ sound }) => {
      const key = `${sound.kind}:${sound.x}:${sound.y}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((p, q) => p.dist - q.dist)
    .slice(0, 4)
    .map(({ sound, dist }) => ({
      ...sound,
      dist: Math.round(dist),
      dir: compass(a, sound.x, sound.y),
      band: distanceBand(dist),
    }));
}
