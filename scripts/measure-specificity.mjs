// 프롬프트 구체성 축 재설계용 1회성 측정 스크립트.
// 후보 신호(지시형 메시지 길이 / 정정 루프 / 러프 위임)가 두 데이터셋에서
// 실제로 어떻게 분포하는지 본다. 앱 코드에는 영향 없음.
//
// usage: node scripts/measure-specificity.mjs <projectsRoot> [days] [--examples]
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const root = process.argv[2];
const days = Number(process.argv[3]) || 0; // 0 = 전체
const showExamples = process.argv.includes('--examples');
if (!root) {
  console.error('usage: node measure-specificity.mjs <projectsRoot> [days] [--examples]');
  process.exit(1);
}

// ---------- parser.ts와 동일한 판정들 ----------
const QUESTION_RE = /[?？]|왜 |어떻게|뭐가|무엇|설명해|이유/;

function isMetaText(t) {
  return (
    t.startsWith('<command-') ||
    t.startsWith('<local-command') ||
    t.includes('<command-name>') ||
    t.startsWith('<system-reminder') ||
    t.startsWith('<task-notification') ||
    t.startsWith('Caveat:') ||
    t.startsWith('This session is being continued')
  );
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text);
    if (parts.length === 0) {
      const hasToolResult = content.some((c) => c && c.type === 'tool_result');
      return hasToolResult ? null : '';
    }
    return parts.join('\n');
  }
  return null;
}

// ---------- 새 후보 신호 판정 ----------
// 승인·진행 신호: 클로드의 질문/제안에 답하는 흐름 제어. 구체성 평가 대상이 아니다
const ACK_RE = /^(응|ㅇㅇ|네|넵|예|좋아|좋다|고고|ㄱㄱ|ok|오케이|오키|그래|당연|맞아|진행해|진행해줘|해줘|그렇게 해|그렇게해|계속|이어서 (진행)?해?줘?|마저 (진행)?해?줘?|커밋해|푸시해|1|2|3|[abc])[.!~ㅋㅎ\s]*$/i;

// 정정 신호: 직전 답이 의도와 달랐다는 표시 (잘못 이해 → 다시 지시)
const CORRECTION_START_RE =
  /^(아니[ ,.!]|아니야|아니지|아냐[ ,]|아니라|그게 아니라|그게아니라|그거 말고|그거말고|그렇게 말고|그런 뜻이 아|내 말은|내말은|다시 해|다시해[ 줘]|롤백|되돌려|원래대로)/;
const CORRECTION_ANY_RE =
  /(그런 뜻이 아니|잘못 이해|잘못 알아|이해를 못|왜 맘대로|왜 마음대로|시키지도 않|내가 언제|라는 게 아니라|라는게 아니라|말한 적 없|그게 아니고)/;

function classify(text) {
  const t = text.trim();
  // 1~2자 구두점·단답("." "ㅇㅇ" 등)은 흐름 제어 노이즈
  if (t.length <= 2 && !QUESTION_RE.test(t)) return 'ack';
  if (/^(응+|네+|넵+|예+|좋아요?|고마워|감사|ㅇㅋ)[.!~ㅋㅎ\s]*$/.test(t)) return 'ack';
  if (ACK_RE.test(t)) return 'ack';
  if (QUESTION_RE.test(t)) return 'question';
  return 'directive';
}

// ---------- 스캔 ----------
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
files.sort((a, b) => a.mtimeMs - b.mtimeMs); // 포크 사본 dedupe: 원본 먼저

// ---------- 수집 ----------
const seenUuids = new Set();
const stats = {
  files: files.length,
  sessions: 0,
  humanMsgs: 0,
  interruptions: 0,
  byClass: { question: 0, directive: 0, ack: 0 },
  directiveLens: [],
  firstLens: [],
  laterDirectiveLens: [], // 세션 첫 메시지를 뺀 지시형 길이
  corrections: 0,
  correctiveDirectives: 0, // 지시형 정정: "잘못 이해했으니 다시 해" (구체성 신호)
  correctiveQuestions: 0, // 질문형 반박: 토론 중 되묻기 (학습 신호에 가깝다)
  correctionExamples: [],
  correctiveDirectiveExamples: [],
  shortDirectives: 0, // 25자 미만 지시형 (ack 아님)
  shortDirectiveExamples: [],
  longDirectives80: 0,
  longDirectives150: 0,
  longDirectives220: 0,
};

for (const f of files) {
  const rl = readline.createInterface({
    input: fs.createReadStream(f.file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let isFirstHuman = true;
  let isContinuation = false;
  let sawAny = false;
  let isFork = false;
  for await (const line of rl) {
    if (!line || line.length > 1_000_000 || !line.includes('"type"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const uid = typeof obj.uuid === 'string' ? obj.uuid : null;
    if (uid) {
      if (seenUuids.has(uid)) {
        if (!sawAny) isFork = true;
        continue;
      }
      seenUuids.add(uid);
    }
    if (obj.type !== 'user') continue;
    const text = extractText(obj.message?.content);
    if (text === null) continue;
    sawAny = true;
    if (text.includes('[Request interrupted')) {
      stats.interruptions++;
      continue;
    }
    const clean = text.trim();
    if (!clean) continue;
    if (clean.startsWith('This session is being continued')) {
      isContinuation = true;
      continue;
    }
    if (isMetaText(clean)) continue;

    stats.humanMsgs++;
    const cls = classify(clean);
    stats.byClass[cls]++;

    if (CORRECTION_START_RE.test(clean) || CORRECTION_ANY_RE.test(clean)) {
      stats.corrections++;
      if (cls === 'directive') {
        stats.correctiveDirectives++;
        if (stats.correctiveDirectiveExamples.length < 20)
          stats.correctiveDirectiveExamples.push(clean.replace(/\s+/g, ' ').slice(0, 90));
      } else if (cls === 'question') {
        stats.correctiveQuestions++;
      }
      if (stats.correctionExamples.length < 20)
        stats.correctionExamples.push(clean.replace(/\s+/g, ' ').slice(0, 90));
    }

    if (cls === 'directive') {
      stats.directiveLens.push(clean.length);
      if (!isFirstHuman) stats.laterDirectiveLens.push(clean.length);
      if (clean.length >= 80) stats.longDirectives80++;
      if (clean.length >= 150) stats.longDirectives150++;
      if (clean.length >= 220) stats.longDirectives220++;
      if (clean.length < 25) {
        stats.shortDirectives++;
        if (stats.shortDirectiveExamples.length < 20)
          stats.shortDirectiveExamples.push(clean.replace(/\s+/g, ' ').slice(0, 60));
      }
    }
    if (isFirstHuman && !isContinuation && !isFork) {
      stats.firstLens.push(clean.length);
      stats.sessions++;
    }
    isFirstHuman = false;
  }
  rl.close();
}

// ---------- 출력 ----------
const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) : '0');
const quantile = (arr, q) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};
const per100 = (v) => (stats.humanMsgs > 0 ? ((v / stats.humanMsgs) * 100).toFixed(2) : '0');

console.log(`\n=== ${root} (days=${days || 'all'}) ===`);
console.log(`files=${stats.files} sessions(starters)=${stats.sessions} humanMsgs=${stats.humanMsgs}`);
console.log(
  `클래스: question ${stats.byClass.question} (${pct(stats.byClass.question, stats.humanMsgs)}%) | directive ${stats.byClass.directive} (${pct(stats.byClass.directive, stats.humanMsgs)}%) | ack ${stats.byClass.ack} (${pct(stats.byClass.ack, stats.humanMsgs)}%)`
);
console.log(`\n[길이] 첫 메시지 median=${quantile(stats.firstLens, 0.5)}  (현행 지표)`);
console.log(
  `[길이] 지시형 전체 median=${quantile(stats.directiveLens, 0.5)} p75=${quantile(stats.directiveLens, 0.75)}  n=${stats.directiveLens.length}`
);
console.log(
  `[길이] 지시형(첫 메시지 제외) median=${quantile(stats.laterDirectiveLens, 0.5)} p75=${quantile(stats.laterDirectiveLens, 0.75)}  n=${stats.laterDirectiveLens.length}`
);
console.log(
  `[길이] 지시형 비중: ≥80자 ${pct(stats.longDirectives80, stats.directiveLens.length)}% | ≥150자 ${pct(stats.longDirectives150, stats.directiveLens.length)}% | ≥220자 ${pct(stats.longDirectives220, stats.directiveLens.length)}%`
);
console.log(
  `\n[정정 루프] 전체 ${stats.corrections}회 (100메시지당 ${per100(stats.corrections)}) | 지시형 정정 ${stats.correctiveDirectives}회 (${per100(stats.correctiveDirectives)}) | 질문형 반박 ${stats.correctiveQuestions}회 (${per100(stats.correctiveQuestions)})`
);
console.log(`[러프 위임] 25자 미만 지시형 ${stats.shortDirectives}회 = 지시형의 ${pct(stats.shortDirectives, stats.byClass.directive)}%`);
console.log(`[중단 Esc] ${stats.interruptions}회 = 100메시지당 ${per100(stats.interruptions)}  (현행 감점 신호)`);

if (showExamples) {
  console.log('\n--- 지시형 정정 예시 ---');
  for (const e of stats.correctiveDirectiveExamples) console.log('  ·', e);
  console.log('\n--- 짧은 지시 예시 ---');
  for (const e of stats.shortDirectiveExamples) console.log('  ·', e);
}
