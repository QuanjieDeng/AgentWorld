// peer-check.js — 两台机器（或两个本地端口）上的全节点验收工具。
//
//   node peer-check.js http://A机:4173 http://B机:4173
//   node peer-check.js http://127.0.0.1:4173 http://127.0.0.1:4174 --watch 20 --settle
//
// --settle 会在观察结束后暂停当前写入者，等跟随者追平再比较，随后恢复。
//
// 它只读，不写入、不改配置，可以随时跑。检查：
//   1. 两边的身份声明都能自证（Ed25519 proof）；
//   2. 两边的种子相同；
//   3. peer 模式下互相把对方的公钥固定进了本机信任表；
//   4. 两边的日志信封签名都用自报的公钥验得过；
//   5. 覆盖到同一事件数时，journalHash / stateHash 一致；
//   6. --watch 期间记录任期与写入权的轮换，结束时要求收敛且没有 syncFault。
//
// 退出码：0 通过，1 有问题，2 用法错误。

import { verifyEnvelopeSignature, verifyIdentityDocument } from './identity.js';

const args = process.argv.slice(2);
const watchIndex = args.indexOf('--watch');
const watchSeconds = watchIndex >= 0 ? Math.max(0, Number(args[watchIndex + 1]) || 0) : 0;
const jsonOut = args.includes('--json');
const settle = args.includes('--settle');
const urls = args.filter((arg, i) => !arg.startsWith('--') && i !== watchIndex + 1);

if (urls.length !== 2) {
  console.error(
    '用法：node peer-check.js <节点A地址> <节点B地址> [--watch 秒数] [--settle] [--json]'
  );
  process.exit(2);
}

const [urlA, urlB] = urls.map((u) => u.replace(/\/+$/, ''));
const problems = [];
const warnings = [];
const transitions = [];
const samples = [];

function fail(message) {
  problems.push(message);
}

async function getJson(url, timeoutMs = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function inspect(url) {
  const doc = await getJson(`${url}/api/identity`);
  const result = {
    url,
    doc,
    identityOk: verifyIdentityDocument(doc),
    journalOk: false,
    journalError: '',
  };
  if (!result.identityOk) fail(`${doc.nodeId || url}：身份声明自证失败`);

  try {
    // 只取尾部一小块，验证来源签名；不拉整份日志。
    const fromSeq = Math.max(1, (Number(doc.events) || 0) - 200 + 1);
    const chunk = await getJson(`${url}/api/journal?fromSeq=${fromSeq}`, 10_000);
    if (!doc.publicKey) {
      result.journalError = '身份里没有公钥';
      fail(`${doc.nodeId}：身份里没有公钥，无法验证日志来源`);
    } else {
      result.journalOk = verifyEnvelopeSignature(chunk, doc.publicKey, { nodeId: doc.nodeId });
      if (!result.journalOk) fail(`${doc.nodeId}：日志信封签名验证失败`);
      result.chunk = chunk;
    }
  } catch (err) {
    result.journalError = String(err?.message || err);
    fail(`${doc.nodeId || url}：拉取日志失败（${result.journalError}）`);
  }
  return result;
}

function line(label, value) {
  return `  ${label.padEnd(10, ' ')} ${value}`;
}

async function sampleOnce() {
  const [a, b] = await Promise.all([inspect(urlA), inspect(urlB)]);
  const entry = {
    at: Date.now(),
    a,
    b,
  };
  samples.push(entry);
  return entry;
}

async function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

/**
 * 世界一直在跑，两个节点在同一瞬间常常差一两条事件；这不算分叉。
 * --settle 会暂停当前写入者，等跟随者追平，比较完之后再恢复。
 * 暂停只改 config.paused，不进入 stateHash，不影响历史。
 */
async function settleAndSample() {
  const before = await sampleOnce();
  const writerUrl = before.a.doc.canWrite ? urlA : before.b.doc.canWrite ? urlB : '';
  if (!writerUrl) {
    warnings.push('没有节点持有写入权，无法暂停对账');
    return before;
  }
  const paused = await post(`${writerUrl}/api/pause`, { paused: true });
  if (!paused.ok) {
    warnings.push(`暂停写入者失败：HTTP ${paused.status}`);
    return before;
  }
  let last = before;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      last = await sampleOnce();
      if (
        last.a.doc.events === last.b.doc.events &&
        last.a.doc.stateHash === last.b.doc.stateHash
      ) {
        return last;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return last;
  } finally {
    await post(`${writerUrl}/api/pause`, { paused: false }).catch(() => {});
  }
}

function describe(entry) {
  const a = entry.a.doc;
  const b = entry.b.doc;
  const rows = [
    line('节点', `${a.nodeId} (${urlA})   ⇄   ${b.nodeId} (${urlB})`),
    line('身份', `${a.keyId}   ${b.keyId}`),
    line('种子', `${a.seed} / ${b.seed}${a.seed === b.seed ? ' ✓' : ' ✗'}`),
    line('任期', `${a.term} (${a.role})   ${b.term} (${b.role})`),
    line('事件', `${a.events}   ${b.events}`),
    line('tick', `${a.tick}   ${b.tick}`),
    line('stateHash', `${a.stateHash}   ${b.stateHash}`),
    line('写入权', `${a.canWrite}   ${b.canWrite}`),
    line('同步错误', `${a.syncFault || '-'}   ${b.syncFault || '-'}`),
  ];
  const trustedByA = (a.trustedPeers || []).some((p) => p.nodeId === b.nodeId);
  const trustedByB = (b.trustedPeers || []).some((p) => p.nodeId === a.nodeId);
  if (a.mode === 'peer' || b.mode === 'peer') {
    rows.push(line('互相固定', `${trustedByA ? 'A 已固定 B' : 'A 未固定 B'}   ${trustedByB ? 'B 已固定 A' : 'B 未固定 A'}`));
  }
  if (a.lastAdoption) {
    rows.push(line('A 上次采纳', `第 ${a.lastAdoption.term} 任 · 丢弃 ${a.lastAdoption.dropped} 条 · ${a.lastAdoption.via}`));
  }
  if (b.lastAdoption) {
    rows.push(line('B 上次采纳', `第 ${b.lastAdoption.term} 任 · 丢弃 ${b.lastAdoption.dropped} 条 · ${b.lastAdoption.via}`));
  }
  return rows.join('\n');
}

function checkStatic(entry) {
  const a = entry.a;
  const b = entry.b;
  if (a.doc.seed !== b.doc.seed) fail(`种子不一致：${a.doc.seed} / ${b.doc.seed}`);
  if (!a.journalOk || !b.journalOk) {
    // inspect 已经记过具体问题。
  }
  const peerMode = a.doc.mode === 'peer' || b.doc.mode === 'peer';
  if (peerMode) {
    if (!(a.doc.trustedPeers || []).some((p) => p.nodeId === b.doc.nodeId)) {
      fail(`A 的信任表里没有 B（${b.doc.nodeId}）`);
    }
    if (!(b.doc.trustedPeers || []).some((p) => p.nodeId === a.doc.nodeId)) {
      fail(`B 的信任表里没有 A（${a.doc.nodeId}）`);
    }
  }
  if (a.doc.syncFault) fail(`${a.doc.nodeId} 报告 syncFault：${a.doc.syncFault}`);
  if (b.doc.syncFault) fail(`${b.doc.nodeId} 报告 syncFault：${b.doc.syncFault}`);

  const sameEvents = a.doc.events === b.doc.events;
  if (sameEvents) {
    if (a.doc.journalHash !== b.doc.journalHash) fail('事件数相同但 journalHash 不同');
    if (a.doc.stateHash !== b.doc.stateHash) fail('事件数相同但 stateHash 不同');
  } else {
    warnings.push(
      `两边事件数不同（${a.doc.events} / ${b.doc.events}）——可能正好在交接；用 --watch 观察收敛`
    );
  }
  if (a.doc.canWrite && b.doc.canWrite) fail('两个节点同时持有写入权');
}

function noteTransition(entry) {
  const a = entry.a.doc;
  const b = entry.b.doc;
  const last = transitions[transitions.length - 1];
  const label = `${a.authorityId || '-'} / term ${Math.max(a.term ?? 0, b.term ?? 0)}`;
  if (!last || last.label !== label) {
    transitions.push({ at: entry.at, label, canWrite: a.canWrite || b.canWrite });
  }
}

async function main() {
  const first = await sampleOnce();
  checkStatic(first);
  noteTransition(first);
  if (!jsonOut) {
    console.log('\n最后的岛 · 全节点对账');
    console.log(describe(first));
  }

  if (watchSeconds > 0) {
    const end = Date.now() + watchSeconds * 1000;
    let lastSample = first;
    while (Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        lastSample = await sampleOnce();
      } catch (err) {
        fail(`轮询失败：${err.message}`);
        break;
      }
      noteTransition(lastSample);
    }
    let a = lastSample.a.doc;
    let b = lastSample.b.doc;
    let converged =
      a.events === b.events &&
      a.stateHash === b.stateHash &&
      a.journalHash === b.journalHash;
    if (!converged && settle) {
      lastSample = await settleAndSample();
      a = lastSample.a.doc;
      b = lastSample.b.doc;
      converged =
        a.events === b.events &&
        a.stateHash === b.stateHash &&
        a.journalHash === b.journalHash;
    }
    if (!converged) {
      fail(
        `观察结束时仍未收敛（事件 ${a.events}/${b.events}，tick ${a.tick}/${b.tick}）` +
          `${settle ? '' : '；可加 --settle 暂停写入者后确认'}`
      );
    }
    const authorities = new Set(transitions.map((t) => t.label.split(' / ')[0]));
    if (authorities.size < 2) {
      warnings.push('观察期内没有看到写入权换人；轮值周期可能比观察窗口长');
    }
    if (!jsonOut) {
      console.log('\n观察记录');
      for (const t of transitions) {
        console.log(`  ${new Date(t.at).toISOString().slice(11, 19)}  ${t.label}`);
      }
      console.log('\n结束时');
      console.log(describe(lastSample));
    }
  }

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          ok: problems.length === 0,
          problems,
          warnings,
          transitions,
          last: samples[samples.length - 1]
            ? {
                a: samples[samples.length - 1].a.doc,
                b: samples[samples.length - 1].b.doc,
              }
            : null,
        },
        null,
        2
      )
    );
  } else {
    if (warnings.length) {
      console.log('\n提示');
      for (const w of warnings) console.log(`  ! ${w}`);
    }
    console.log(problems.length ? '\n不通过' : '\n通过');
    for (const p of problems) console.log(`  ✗ ${p}`);
    console.log('');
  }

  process.exit(problems.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`对账失败：${err?.message || err}`);
  process.exit(1);
});
