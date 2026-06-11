// 컨텍스트 운용 축 재설계용 1회성 측정 스크립트.
// 어시스턴트 턴마다 실제로 끌고 간 컨텍스트 크기(input + cacheRead + cacheCreate)의
// 분포를 본다. 앱 코드에는 영향 없음.
//
// usage: node scripts/measure-context.mjs <projectsRoot> [days]
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const root = process.argv[2];
const days = Number(process.argv[3]) || 0;
if (!root) {
  console.error('usage: node measure-context.mjs <projectsRoot> [days]');
  process.exit(1);
}

function listJsonl(dir, out, depth = 0) {
  if (depth > 4) return out;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const p = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) listJsonl(p, out, depth + 1);
    else if (name.endsWith('.jsonl') && !p.includes(`${path.sep}subagents${path.sep}`))
      out.push({ file: p, mtimeMs: st.mtimeMs });
  }
  return out;
}

const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
const files = listJsonl(root, []).filter((f) => f.mtimeMs >= cutoff);
files.sort((a, b) => a.mtimeMs - b.mtimeMs);

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
const seenUuids = new Set();
const ctxSizes = []; // 턴별 컨텍스트 크기 (토큰)

for (const f of files) {
  const rl = readline.createInterface({
    input: fs.createReadStream(f.file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  const seenMsgIds = new Set(); // 같은 message.id의 usage 중복 합산 방지 (parser.ts와 동일)
  for await (const line of rl) {
    if (!line || line.length > 1_000_000 || !line.includes('"usage"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const uid = typeof obj.uuid === 'string' ? obj.uuid : null;
    if (uid) {
      if (seenUuids.has(uid)) continue;
      seenUuids.add(uid);
    }
    if (obj.type !== 'assistant' || !obj.message?.usage) continue;
    const id = typeof obj.message.id === 'string' ? obj.message.id : uid;
    if (id) {
      if (seenMsgIds.has(id)) continue;
      seenMsgIds.add(id);
    }
    const u = obj.message.usage;
    const ctx = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    if (ctx > 0) ctxSizes.push(ctx);
  }
  rl.close();
}

ctxSizes.sort((a, b) => a - b);
const q = (p) => (ctxSizes.length ? ctxSizes[Math.min(ctxSizes.length - 1, Math.floor(ctxSizes.length * p))] : 0);
const share = (t) => (ctxSizes.length ? ctxSizes.filter((v) => v >= t).length / ctxSizes.length : 0);
const k = (v) => (v / 1000).toFixed(0) + 'k';
const pc = (v) => (v * 100).toFixed(1) + '%';

console.log(`\n=== ${root} (days=${days || 'all'}) ===`);
console.log(`턴 수(usage 있는 어시스턴트 메시지): ${ctxSizes.length}`);
console.log(`컨텍스트 크기: median ${k(q(0.5))} | p75 ${k(q(0.75))} | p90 ${k(q(0.9))} | p99 ${k(q(0.99))}`);
console.log(`무거운 턴 비중: ≥60k ${pc(share(60000))} | ≥100k ${pc(share(100000))} | ≥150k ${pc(share(150000))}`);
const totalCtx = ctxSizes.reduce((a, v) => a + v, 0);
const heavyCtx = ctxSizes.filter((v) => v >= 100000).reduce((a, v) => a + v, 0);
console.log(`토큰 가중 무거운 비중(≥100k 턴이 끌고 간 토큰/전체): ${pc(totalCtx > 0 ? heavyCtx / totalCtx : 0)}`);
