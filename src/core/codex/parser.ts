import * as fs from 'fs';
import * as readline from 'readline';
import { ActivityCount, CodexSession } from '../types';
import { ScannedCodexFile } from './scanner';
// 텍스트 분석 정규식·함수는 Claude 파서와 공유한다(한국어 질문/지시/의도 패턴은 도구와 무관하게 유효).
import { QUESTION_RE, ACK_RE, WHY_RE, CONFIRM_RE, GRAB_RE, FILE_REF_RE, VERIFY_RE, VERIFY_CMD_RE, AT_MENTION_RE, INTENT_RES, commandVerbs, isMetaText } from '../parser';

const MAX_LINE_LENGTH = 2_000_000;
const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);

function localDay(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// 사람 메시지에 박히는 스킬 멘션: [$skill-name](path) — 캡처그룹으로 스킬 이름을 뽑는다
const SKILL_MENTION_RE = /\[\$([\w-]+)\]\([^)]*\)/g;

const FRONT_EXTS = new Set(['html', 'htm', 'css', 'scss', 'sass', 'less', 'tsx', 'jsx', 'vue', 'svelte']);
const CODE_EXTS = new Set([
  'java', 'kt', 'kts', 'py', 'ts', 'js', 'mjs', 'cjs', 'sql', 'go', 'rs', 'rb',
  'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'sh', 'zsh', 'bash',
]);

function newSession(file: string): CodexSession {
  return {
    file,
    cwd: null,
    originator: null,
    category: '기타',
    firstPrompt: '',
    intentHits: {},
    firstTs: null,
    lastTs: null,
    durationMin: 0,
    userMsgs: 0,
    humanMsgs: 0,
    questionMsgs: 0,
    directiveMsgs: 0,
    substantiveDirectives: 0,
    fileRefDirectives: 0,
    verifyDirectives: 0,
    atMentions: 0,
    skillMentions: 0,
    learning: { chain2: 0, chain3: 0, grabQs: 0, whyQs: 0, confirmQs: 0 },
    taskStarted: 0,
    taskComplete: 0,
    aborted: 0,
    rolledBack: 0,
    toolChain: 0,
    toolFailures: 0,
    toolFailuresResolved: 0,
    applyPatches: 0,
    execRuns: 0,
    verifyRuns: 0,
    planUses: 0,
    goalUses: 0,
    webSearches: 0,
    mcpCalls: 0,
    writeStdins: 0,
    reasoningCount: 0,
    skillUses: {},
    tokens: { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 },
    toolCounts: {},
    activities: {},
    daily: {},
  };
}

export async function parseCodexSession(f: ScannedCodexFile): Promise<CodexSession> {
  const s = newSession(f.file);
  // 연속 질문 체인 추적(직전 사람 메시지가 질문이었는지) — Claude 파서와 동일
  const qState = { prevQ: false, run: 0 };
  // 오류 회복 추적: 아직 성공으로 닫히지 않은 실패 수
  const rec = { pending: 0 };
  const stream = fs.createReadStream(f.file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line || line.length > MAX_LINE_LENGTH) continue;
      if (!line.includes('"type"')) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      ingest(o, s, qState, rec);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  if (s.firstTs !== null && s.lastTs !== null) s.durationMin = Math.max(0, (s.lastTs - s.firstTs) / 60000);
  return s;
}

function ingest(o: any, s: CodexSession, qState: { prevQ: boolean; run: number }, rec: { pending: number }): void {
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  if (!isNaN(ts)) {
    if (s.firstTs === null || ts < s.firstTs) s.firstTs = ts;
    if (s.lastTs === null || ts > s.lastTs) s.lastTs = ts;
  }
  const p = o.payload;
  if (!p || typeof p !== 'object') return;

  if (o.type === 'session_meta') {
    if (typeof p.cwd === 'string') s.cwd = p.cwd;
    if (typeof p.originator === 'string') s.originator = p.originator;
    return;
  }
  if (o.type === 'turn_context') {
    if (!s.cwd && typeof p.cwd === 'string') s.cwd = p.cwd;
    return;
  }
  if (o.type === 'event_msg') {
    handleEvent(p, s, ts, qState);
    return;
  }
  if (o.type === 'response_item') {
    handleResponseItem(p, s, rec);
    return;
  }
}

function handleEvent(p: any, s: CodexSession, ts: number, qState: { prevQ: boolean; run: number }): void {
  switch (p.type) {
    case 'user_message':
      handleUserMsg(typeof p.message === 'string' ? p.message : '', s, qState);
      break;
    case 'token_count': {
      const info = p.info;
      if (!info || typeof info !== 'object') break;
      // total_token_usage 는 세션 누적값 → 마지막 것이 세션 총합. last_token_usage 는 이번 턴 증분 → daily.
      const total = info.total_token_usage;
      if (total && typeof total === 'object') {
        s.tokens = {
          input: num(total.input_tokens),
          cachedInput: num(total.cached_input_tokens),
          output: num(total.output_tokens),
          reasoning: num(total.reasoning_output_tokens),
          total: num(total.total_tokens),
        };
      }
      const last = info.last_token_usage;
      if (last && typeof last === 'object' && !isNaN(ts)) {
        s.daily[localDay(ts)] = (s.daily[localDay(ts)] ?? 0) + num(last.total_tokens);
      }
      break;
    }
    case 'task_started':
      s.taskStarted++;
      break;
    case 'task_complete':
      s.taskComplete++;
      break;
    case 'turn_aborted':
      s.aborted++;
      break;
    case 'thread_rolled_back':
      s.rolledBack++;
      break;
  }
}

function handleUserMsg(raw: string, s: CodexSession, qState: { prevQ: boolean; run: number }): void {
  if (!raw) return;
  SKILL_MENTION_RE.lastIndex = 0;
  let mention: RegExpExecArray | null;
  while ((mention = SKILL_MENTION_RE.exec(raw))) {
    s.skillMentions++;
    s.skillUses[mention[1]] = (s.skillUses[mention[1]] ?? 0) + 1;
  }
  // 스킬 멘션 링크(경로 포함)는 길이를 부풀리므로 제거 후 사람 텍스트만 본다
  const clean = raw.replace(SKILL_MENTION_RE, ' ').trim();
  if (!clean || isMetaText(clean) || clean.includes('[Request interrupted')) return;

  s.userMsgs++;
  s.humanMsgs++;
  if (AT_MENTION_RE.test(clean)) s.atMentions++;
  for (const it of INTENT_RES) {
    if (it.re.test(clean)) s.intentHits[it.name] = (s.intentHits[it.name] ?? 0) + 1;
  }
  const isQ = QUESTION_RE.test(clean);
  const isAck = (clean.length <= 2 && !isQ) || ACK_RE.test(clean);
  if (!isQ && !isAck) {
    s.directiveMsgs++;
    if (clean.length >= 80) s.substantiveDirectives++;
    if (FILE_REF_RE.test(clean)) s.fileRefDirectives++;
    if (VERIFY_RE.test(clean)) s.verifyDirectives++;
  }
  if (isQ) {
    s.questionMsgs++;
    if (WHY_RE.test(clean)) s.learning.whyQs++;
    if (CONFIRM_RE.test(clean)) s.learning.confirmQs++;
    if (GRAB_RE.test(clean)) s.learning.grabQs++;
    // 체인: 직전 사람 메시지도 질문이면 이어지는 중. 2·3에 닿는 순간만 센다(체인당 1회)
    qState.run = qState.prevQ ? qState.run + 1 : 1;
    if (qState.run === 2) s.learning.chain2++;
    if (qState.run === 3) s.learning.chain3++;
  } else {
    qState.run = 0;
  }
  qState.prevQ = isQ;
  if (!s.firstPrompt) s.firstPrompt = clean.slice(0, 300);
}

function handleResponseItem(p: any, s: CodexSession, rec: { pending: number }): void {
  switch (p.type) {
    case 'function_call':
      handleFunctionCall(p, s);
      break;
    case 'custom_tool_call':
      if (p.name === 'apply_patch') {
        s.applyPatches++;
        s.toolChain++;
        bump(s.toolCounts, 'apply_patch');
        addActivity(s, classifyPatch(typeof p.input === 'string' ? p.input : ''), patchExts(typeof p.input === 'string' ? p.input : ''));
      }
      break;
    case 'web_search_call':
      s.webSearches++;
      s.toolChain++;
      bump(s.toolCounts, 'web_search');
      addActivity(s, '웹 검색·조사', []);
      break;
    case 'reasoning':
      s.reasoningCount++;
      break;
    case 'function_call_output':
    case 'custom_tool_call_output':
      handleToolOutput(p, s, rec);
      break;
  }
}

// 오류 회복·수렴: 도구 실행 결과. 비0 종료/실패면 분자(toolFailures), 성공이면 이전 실패들을 닫는다.
// Codex는 종료코드가 구조화 필드가 아니라 output 문자열에 "Process exited with code N" 으로 박힌다.
const EXIT_FAIL_RE = /exited with code [1-9]/i;
function handleToolOutput(p: any, s: CodexSession, rec: { pending: number }): void {
  const out = typeof p.output === 'string' ? p.output : '';
  const failed = p.success === false || EXIT_FAIL_RE.test(out);
  if (failed) {
    s.toolFailures++;
    rec.pending++;
  } else {
    s.toolFailuresResolved += rec.pending;
    rec.pending = 0;
  }
}

function handleFunctionCall(p: any, s: CodexSession): void {
  const name = typeof p.name === 'string' ? p.name : '';
  if (!name) return;
  s.toolChain++;
  bump(s.toolCounts, name);
  const args = parseArgs(p.arguments);

  if (name === 'exec_command' || name === 'shell_command') {
    s.execRuns++;
    const cmd = typeof args.cmd === 'string' ? args.cmd : typeof args.command === 'string' ? args.command : '';
    if (VERIFY_CMD_RE.test(cmd)) s.verifyRuns++;
    addActivity(s, '명령 실행', commandVerbs(cmd));
  } else if (name === 'write_stdin') {
    s.writeStdins++;
    addActivity(s, '대화형 실행', []);
  } else if (name === 'update_plan') {
    s.planUses++;
    addActivity(s, '계획·설계', []);
  } else if (name === 'create_goal' || name === 'update_goal') {
    s.goalUses++;
    addActivity(s, '계획·설계', []);
  } else if (name.startsWith('_') || name.startsWith('mcp')) {
    s.mcpCalls++;
    addActivity(s, '외부 연동(MCP)', []);
  } else {
    addActivity(s, '기타 도구', []);
  }
}

function parseArgs(a: unknown): any {
  if (typeof a !== 'string') return {};
  try {
    return JSON.parse(a);
  } catch {
    return {};
  }
}

function bump(rec: Record<string, number>, k: string): void {
  rec[k] = (rec[k] ?? 0) + 1;
}

function addActivity(s: CodexSession, act: string, details: string[]): void {
  const a: ActivityCount = s.activities[act] ?? (s.activities[act] = { msgs: 0, output: 0, total: 0, details: {} });
  a.msgs++;
  // Codex는 도구별 토큰 귀속이 불가능(토큰이 턴 누적)하므로 total=도구 호출 수로 집계한다
  a.total++;
  for (const d of details) a.details[d] = (a.details[d] ?? 0) + 1;
}

// apply_patch 의 patch 텍스트에서 대상 파일 경로들의 확장자를 뽑는다
const PATCH_FILE_RE = /\*\*\* (?:Update|Add|Delete) File: (.+)/g;
function patchExts(input: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  PATCH_FILE_RE.lastIndex = 0;
  while ((m = PATCH_FILE_RE.exec(input))) {
    const fp = m[1].trim();
    const dot = fp.lastIndexOf('.');
    if (dot > 0) out.push(fp.slice(dot + 1).toLowerCase());
  }
  return out;
}

function classifyPatch(input: string): string {
  const exts = patchExts(input);
  if (exts.length === 0) return '문서·설정 파일';
  let front = 0;
  let code = 0;
  let doc = 0;
  for (const e of exts) {
    if (FRONT_EXTS.has(e)) front++;
    else if (CODE_EXTS.has(e)) code++;
    else doc++;
  }
  if (front > 0 && front >= code && front >= doc) return '프론트 코드';
  if (code > 0 && code >= doc) return '서버·스크립트 코드';
  return '문서·설정 파일';
}
