// test-cycles.js — 验证资源循环：再生、坟边长灌木、捕鱼、耕种。
// 用法：node test-cycles.js

import { createWorld, tick, kill, TILE, W, H, TICKS_PER_DAY } from './engine.js';

function findTile(world, type) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (world.map[y * W + x] === type) return { x, y };
    }
  }
  return null;
}

function isolate(world, keep = null) {
  world.agents.forEach((a) => {
    if (a !== keep) a.alive = false;
  });
}

// 1. 采掉一丛灌木，等 1.5 天，看它长不长得回来
{
  const w = createWorld(1);
  const a = w.agents[0];
  isolate(w, a);

  const bush = findTile(w, TILE.BUSH);
  a.x = bush.x;
  a.y = bush.y - 1;
  if (![TILE.GRASS, TILE.RUIN, TILE.BUSH].includes(w.map[a.y * W + a.x])) {
    a.x = bush.x + 1;
    a.y = bush.y;
  }

  a.action = { type: 'gather', remaining: 1 };
  tick(w);

  const depleted = w.map[bush.y * W + bush.x] === TILE.GRASS;
  const scheduled = w.regrow.length > 0;
  console.log('灌木采集:', depleted ? '已采空' : '未采空', '| 再生已排队:', scheduled ? '是' : '否');

  a.alive = false;
  for (let i = 0; i < Math.round(1.5 * TICKS_PER_DAY) + 10; i++) tick(w);
  const regrown = w.map[bush.y * W + bush.x] === TILE.BUSH;
  console.log('1.5 天后:', regrown ? '长回来了' : '没有长回来');
}

// 2. 一个人死在草地上，2 天后坟边有没有灌木
{
  const w = createWorld(1);
  const a = w.agents[0];
  a.x = 20;
  a.y = 20;
  isolate(w); // 先全部弄死，避免别人捣乱
  a.alive = true;
  kill(w, a, '测试。');
  const queued = w.regrow.length;
  console.log('坟边肥土:', queued > 0 ? `已排队 ${queued} 处` : '没有排队');

  for (let i = 0; i < 2 * TICKS_PER_DAY + 10; i++) tick(w);
  let bushes = 0;
  for (let y = 18; y <= 22; y++) {
    for (let x = 18; x <= 22; x++) {
      if (w.map[y * W + x] === TILE.BUSH) bushes++;
    }
  }
  console.log('2 天后坟边灌木:', bushes);
}

// 3. 水边捕鱼（老唐是渔夫，天生会捕鱼）
{
  const w = createWorld(1);
  const a = w.agents.find((x) => x.name === '老唐');
  isolate(w, a);

  let spot = null;
  outer: for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (w.map[y * W + x] !== TILE.WATER) continue;
      const opts = [
        [x, y - 1],
        [x, y + 1],
        [x - 1, y],
        [x + 1, y],
      ].filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < W && ny < H && w.map[ny * W + nx] !== TILE.WATER);
      if (opts.length) {
        spot = opts[0];
        break outer;
      }
    }
  }

  if (!spot) {
    console.log('水边捕鱼: 找不到岸边');
  } else {
    a.x = spot[0];
    a.y = spot[1];
    a.inventory.food = 0;

    for (let i = 0; i < 20; i++) {
      a.action = { type: 'fish', remaining: 1 };
      tick(w);
    }
    console.log('水边捕鱼 20 次:', a.inventory.food > 0 ? `得到 ${a.inventory.food} 份食物` : '一条也没捕到');
  }
}

// 4. 耕种（林氏是农妇，天生会种）
{
  const w = createWorld(1);
  const a = w.agents.find((x) => x.name === '林氏');
  isolate(w, a);
  a.x = 20;
  a.y = 20;
  a.inventory.food = 2;
  a.action = { type: 'plant', remaining: 1 };
  tick(w);
  console.log('耕种:', a.inventory.food === 1 ? '消耗了 1 份食物' : '没有消耗', '| 已排队:', w.regrow.length > 0 ? '是' : '否');

  a.alive = false;
  for (let i = 0; i < 2 * TICKS_PER_DAY + 10; i++) tick(w);
  console.log('2 天后原地:', w.map[20 * W + 20] === TILE.BUSH ? '长出了灌木' : '什么也没长');
}
