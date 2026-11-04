// arrival.js — 真人上传的密码学外壳。
//
// 引擎负责“这个人合不合法、落在哪、带什么技能”；这里负责三件传输层的事：
//   1. 轻量 PoW：把字段和 nonce 一起哈希，要求前 N 个十六进制位是 0；
//   2. 创建者签名：由上传者本机节点的 Ed25519 私钥签；
//   3. 校验：PoW、字段、公钥指纹、签名，任何一项不过都不进日志。
//
// 上传记录会原样写进 arrival 事件；重放时引擎只看 core，不重新验签。
// 也就是说，验签发生在入口（server.js），日志一旦被接受就被信任。

import { createHash } from 'node:crypto';
import { stableStringify } from './sync.js';
import { normalizeArrivalCore, validateArrivalCore } from './engine.js';
import {
  keyIdFromPublicKey,
  normalizePublicKey,
  signPayload,
  verifyPayload,
} from './identity.js';

export const ARRIVAL_VERSION = 'island-arrival/1';
export const DEFAULT_ARRIVAL_DIFFICULTY = 3; // 前 3 个十六进制 0，平均约 4096 次哈希

function fail(reason) {
  return { ok: false, reason };
}

export function arrivalHash(core, nonce) {
  const text = stableStringify({ version: ARRIVAL_VERSION, core, nonce });
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function verifyArrivalPoW(core, pow, difficulty = DEFAULT_ARRIVAL_DIFFICULTY) {
  if (!pow || !Number.isInteger(pow.nonce) || pow.nonce < 0) return false;
  const d = Math.max(0, Math.min(8, Math.floor(Number(difficulty) || 0)));
  return arrivalHash(normalizeArrivalCore(core), pow.nonce).startsWith('0'.repeat(d));
}

/**
 * 浏览器和命令行共用同一套哈希。maxTries 只是防止参数写错时死循环。
 */
export function mineArrival(core, difficulty = DEFAULT_ARRIVAL_DIFFICULTY, { maxTries = 5_000_000 } = {}) {
  const normalized = normalizeArrivalCore(core);
  const d = Math.max(0, Math.min(8, Math.floor(Number(difficulty) || 0)));
  const prefix = '0'.repeat(d);
  for (let nonce = 0; nonce < maxTries; nonce++) {
    const hash = arrivalHash(normalized, nonce);
    if (hash.startsWith(prefix)) {
      return { nonce, difficulty: d, hash, core: normalized };
    }
  }
  throw new Error(`PoW 在 ${maxTries} 次内没有找到 nonce`);
}

export function signArrival(identity, core, pow, { playerId = null } = {}) {
  const normalized = normalizeArrivalCore(core);
  const pid = playerId ? String(playerId).slice(0, 64) : null;
  const body = {
    version: ARRIVAL_VERSION,
    core: normalized,
    pow: { nonce: pow.nonce, difficulty: pow.difficulty },
    playerId: pid,
  };
  return {
    ...body,
    creator: {
      nodeId: identity.nodeId,
      keyId: identity.keyId,
      publicKey: normalizePublicKey(identity.publicKey),
      playerId: pid,
    },
    signature: signPayload(identity, body),
  };
}

export function verifyArrivalRecord(record, difficulty = DEFAULT_ARRIVAL_DIFFICULTY) {
  if (!record || typeof record !== 'object') return fail('not an arrival record');
  if (record.version !== ARRIVAL_VERSION) return fail('arrival version mismatch');

  const checked = validateArrivalCore(record.core);
  if (!checked.ok) return checked;
  const core = checked.core;

  if (!record.pow || !verifyArrivalPoW(core, record.pow, difficulty)) {
    return fail('proof of work failed');
  }

  const creator = record.creator;
  if (!creator || typeof creator !== 'object') return fail('missing creator');
  if (!creator.nodeId || !creator.publicKey) return fail('creator is incomplete');
  if (keyIdFromPublicKey(creator.publicKey) !== creator.keyId) {
    return fail('creator key id mismatch');
  }

  // playerId 是后加的字段：旧记录没有它，按旧格式验签；新记录一定带（可以是 null）。
  const pid = record.playerId ?? creator.playerId ?? null;
  if (creator.playerId && record.playerId && creator.playerId !== record.playerId) {
    return fail('player id mismatch');
  }
  const body = Object.prototype.hasOwnProperty.call(record, 'playerId')
    ? {
        version: record.version,
        core,
        pow: { nonce: record.pow.nonce, difficulty: record.pow.difficulty },
        playerId: pid,
      }
    : {
        version: record.version,
        core,
        pow: { nonce: record.pow.nonce, difficulty: record.pow.difficulty },
      };
  if (!verifyPayload(creator.publicKey, body, record.signature)) {
    return fail('creator signature invalid');
  }
  return { ok: true, core, playerId: pid };
}
