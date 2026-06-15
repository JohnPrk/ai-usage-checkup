import * as fs from 'fs';
import * as readline from 'readline';
import { SessionSummary } from './types';
import { ScannedFile } from './scanner';

// 이미지 base64 등 비정상적으로 큰 라인은 통째로 건너뛴다 (usage가 들어있지 않은 라인들)
const MAX_LINE_LENGTH = 1_000_000;

const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);

// 사용자 기준(로컬 시간대)의 날짜 키. UTC로 자르면 저녁 세션이 다음 날로 밀린다
function localDay(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// 한 메시지(id 기준)의 도구·파일 확장자를 라인들에 걸쳐 모은다
interface MsgMeta {
  tools: string[];
  exts: string[];
  verbs: string[]; // Bash 명령의 첫 단어들 (git, npm, …)
  output: number;
  total: number;
}

const FRONT_EXTS = new Set(['html', 'htm', 'css', 'scss', 'sass', 'less', 'tsx', 'jsx', 'vue', 'svelte']);
const CODE_EXTS = new Set([
  'java', 'kt', 'kts', 'py', 'ts', 'js', 'mjs', 'cjs', 'sql', 'go', 'rs', 'rb',
  'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'sh', 'zsh', 'bash',
]);
const READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead']);

// 학습 주도성의 분자: 질문형 메시지 판정
const QUESTION_RE = /[?？]|왜 |어떻게|뭐가|무엇|설명해|이유/;
// 단순 승인·진행 신호: 클로드의 질문/제안에 답하는 흐름 제어라 지시형 구체성 평가에서 제외
const ACK_RE =
  /^(응+|ㅇ+|네+|넵+|예+|좋아요?|좋다|고고|ㄱㄱ|ok|오케이|오키|ㅇㅋ|그래|당연|맞아|진행해|진행해줘|해줘|그렇게 해|그렇게해|계속|이어서 (진행)?해?줘?|마저 (진행)?해?줘?|커밋해|푸시해|고마워|감사|[0-9]{1,2}번?|[a-d]안?)[.!~ㅋㅎ\s]*$/i;
// 학습 주도성 세부 신호 (질문형 메시지 안에서 판정)
const WHY_RE = /왜 |왜\?|이유|원리|어째서|왜냐|내부적으로|차이가? 뭐|뭐가 달라/;
const CONFIRM_RE = /맞아\?|맞지\?|라는 ?거(야|지|네)?\?|란 ?거(야|지)?\?|거구나|인 ?건가\?/;
const GRAB_RE = /^(근데|그럼 |그러면|그렇다면|아 |오 |잠깐|아니 그)/;
// 구체성 보강(Best Practices): 지시가 구체 파일/경로/@ 를 지목하는가
const FILE_REF_RE =
  /@[\w./-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|kt|kts|go|rs|rb|swift|c|cc|cpp|h|hpp|sh|zsh|bash|sql|html?|css|scss|sass|less|json|md|ya?ml|toml|xml|vue|svelte|gradle|properties|txt|csv)\b|(?:^|[\s(])(?:src|app|lib|components?|pages?|dist|tests?|spec|core|utils?|scripts?)\//i;
// 검증 보강(Best Practices "Give Claude a way to verify"): 테스트·빌드·검증 실행을 요청하는가
const VERIFY_RE =
  /테스트|test\b|빌드|build\b|컴파일|compile|린트|lint\b|타입\s?체크|typecheck|tsc\b|스크린샷|screenshot|돌려|실행(?:해|시켜)|검증|run the (?:tests?|build)/i;
// @ 파일 멘션: 경로(슬래시 포함) 또는 파일.확장자를 동반한 @ 만 인정 (@media·@핸들·@패키지 오탐 줄임)
const AT_MENTION_RE = /(?:^|[\s(])@(?:[\w.-]+\/[\w./-]*|[\w-]+\.\w{1,6}\b)/;
// 확장 사고 escalation: 의도적으로 더 깊은 사고를 요청한 트리거(ultrathink 등). 늘 켜둔 자동 thinking과 구분한다
const THINK_ESCALATE_RE = /\bultrathink\b|\bmegathink\b|\bthink (?:hard|harder|deeply|more|a lot|step by step|really)/i;

// 작업 의도 분류: 세션 전체 사람 메시지에서 어떤 의도가 몇 번 드러났는지 센다 (디렉토리·첫 문장이 아니라 내용으로 분류).
// 구체적인 의도(버그·학습·글쓰기·환경·리팩토링)를 먼저 두고, '기능 개발'은 넓은 기본 의도라 마지막.
const INTENT_RES: { name: string; re: RegExp }[] = [
  { name: '버그 수정', re: /버그|에러|오류|안 ?(돼|되|나오|나와|먹|뜨|작동)|동작 ?안|실패(?:해|했|하)|깨[지졌]|터[지졌]|크래시|crash|exception|undefined|널 ?포인터|타입 ?에러|stack ?trace|고쳐|디버[그깅]|debug|문제[가 ]|이상[해하]|왜 안|재현/i },
  { name: '리팩토링', re: /리팩[토터]|refactor|구조 ?(개선|변경|바꾸)|분리해|추출(?:해|하)|중복 ?(제거|줄)|네이밍|이름 ?(바꾸|변경|짓)|rename|깔끔(?:하게|히)|클린|clean ?up|모듈화|책임 ?분리/i },
  { name: '학습·이해', re: /설명해|이해 ?(안|못|하고)|원리|개념|어떻게 ?(동작|작동|돌아가|구현|쓰)|차이[가 ]|왜 |이유[가 ]|알고리즘|공부|배우|학습|문서 ?(읽|보|확인)|무슨 ?(의미|뜻)|뭐가 ?(달라|다르)|동작 ?방식|궁금/i },
  { name: '글쓰기', re: /회고|블로그|포스트|글 ?(써|작성|쓰|정리)|readme|독후|문서 ?작성|초안|번역|가사|발표 ?자료|슬라이드|ppt|본문|마크다운 ?(작성|글)/i },
  { name: '환경 설정', re: /설정|config|패키징|빌드 ?(설정|환경)|배포|deploy|\bci\b|github ?action|워크플로|package\.json|tsconfig|\.env|electron-builder|설치(?:해|하|할)|\binstall\b|환경 ?(설정|구성)|세팅|의존성|dependency|버전 ?(업|올려)|훅 ?(설정|추가|걸)|mcp ?(설정|추가|연결)/i },
  { name: '기능 개발', re: /추가(?:해|하|좀)|만들[어자]|구현|기능 ?(추가|개발|만들)|새 ?(기능|화면|페이지|컴포넌트)|붙여|적용해|넣어 ?줘?|개발|화면 ?(만들|추가)|컴포넌트|feature|implement/i },
];

// 명령 문자열에서 의미 있는 첫 단어들을 뽑는다: "cd x && npm test" → [npm]
const NOISE_VERBS = new Set(['cd', 'echo', 'true', 'sleep', 'export', 'set', 'source', 'time']);
function commandVerbs(cmd: string): string[] {
  const out: string[] = [];
  for (const part of cmd.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
    const w = part.trim().split(/\s+/)[0] ?? '';
    const v = w.split('/').pop()?.toLowerCase() ?? '';
    if (!v || !/^[a-z][a-z0-9_.-]*$/.test(v) || NOISE_VERBS.has(v)) continue;
    out.push(v);
    if (out.length >= 4) break;
  }
  return out;
}

function classifyActivity(tools: string[], exts: string[]): string {
  if (tools.length === 0) return '대화·설계';
  if (tools.some((t) => /^mcp__(computer-use|claude[-_]in[-_]chrome|Claude_in_Chrome|Claude_Preview)/i.test(t))) {
    return '컴퓨터·브라우저 제어';
  }
  if (exts.length > 0) {
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
  if (tools.includes('Bash')) return '명령 실행';
  if (tools.every((t) => READONLY_TOOLS.has(t))) return '코드 읽기·검수';
  return '기타 도구';
}

// seenUuids: 파일 간 공유 세트. 포크·워크트리 사본의 복제 라인을 한 번만 집계하기 위해 호출자가 넘긴다
export async function parseSession(
  f: ScannedFile,
  seenUuids: Set<string> = new Set()
): Promise<{ session: SessionSummary; skippedLines: number }> {
  const s: SessionSummary = {
    file: f.file,
    projectDir: f.projectDir,
    isSubagentFile: f.isSubagentFile,
    isContinuation: false,
    isForkChild: false,
    rootUuid: null,
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
    thinkEscalations: 0,
    imageInputs: 0,
    backgroundRuns: 0,
    atMentions: 0,
    learning: { chain2: 0, chain3: 0, grabQs: 0, whyQs: 0, confirmQs: 0 },
    assistantMsgs: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0 },
    perModel: {},
    interruptions: 0,
    compacts: 0,
    slashCommands: [],
    hasSidechain: false,
    cwd: null,
    entrypoint: null,
    toolCounts: {},
    skillUses: {},
    activities: {},
    daily: {},
  };
  // 같은 message.id가 여러 라인(콘텐츠 블록별)에 같은 usage를 반복 기록하므로 중복 합산을 막는다
  const seenMessageIds = new Set<string>();
  const msgMeta = new Map<string, MsgMeta>();
  // 연속 질문 체인 추적 (직전 사람 메시지가 질문이었는지)
  const qState = { prevQ: false, run: 0 };
  let skippedLines = 0;

  const stream = fs.createReadStream(f.file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      if (line.length > MAX_LINE_LENGTH) {
        // 붙여넣은 이미지는 base64라 라인이 거대해 통째로 스킵된다. JSON 파싱 없이 사용 여부만 싸게 본다
        // (tool_result 스크린샷은 제외 — 사용자가 직접 붙인 입력만)
        if (line.includes('"type":"image"') && line.includes('"type":"user"') && !line.includes('"tool_result"')) {
          s.imageInputs++;
        }
        skippedLines++;
        continue;
      }
      if (!line.includes('"type"')) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        skippedLines++;
        continue;
      }
      const uid = typeof obj.uuid === 'string' ? obj.uuid : null;
      if (uid) {
        if (!s.rootUuid) s.rootUuid = uid;
        if (seenUuids.has(uid)) {
          // 다른 파일이 이미 집계한 복제 라인. 고유 내용이 나오기 전부터 복제라면 이 파일은 포크 사본이다
          if (s.userMsgs + s.assistantMsgs === 0) s.isForkChild = true;
          continue;
        }
        seenUuids.add(uid);
      }
      ingest(obj, s, seenMessageIds, msgMeta, qState);
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (s.firstTs !== null && s.lastTs !== null) {
    s.durationMin = Math.max(0, (s.lastTs - s.firstTs) / 60000);
  }
  // 메시지별 도구 사용이 다 모인 뒤에야 활동을 확정할 수 있다
  for (const meta of msgMeta.values()) {
    const act = classifyActivity(meta.tools, meta.exts);
    const a = s.activities[act] ?? (s.activities[act] = { msgs: 0, output: 0, total: 0, details: {} });
    a.msgs++;
    a.output += meta.output;
    a.total += meta.total;
    // 활동의 실제 내용물: 명령 실행이면 명령어, 파일 작업이면 확장자
    const items = act === '명령 실행' ? meta.verbs : meta.exts;
    for (const it of items) a.details[it] = (a.details[it] ?? 0) + 1;
  }
  return { session: s, skippedLines };
}

function ingest(
  obj: any,
  s: SessionSummary,
  seenMessageIds: Set<string>,
  msgMeta: Map<string, MsgMeta>,
  qState: { prevQ: boolean; run: number }
): void {
  if (obj.isCompactSummary === true) s.compacts++;
  if (obj.isSidechain === true) s.hasSidechain = true;
  if (typeof obj.timestamp === 'string') {
    const t = Date.parse(obj.timestamp);
    if (!isNaN(t)) {
      if (s.firstTs === null || t < s.firstTs) s.firstTs = t;
      if (s.lastTs === null || t > s.lastTs) s.lastTs = t;
    }
  }
  if (typeof obj.cwd === 'string' && !s.cwd) s.cwd = obj.cwd;
  if (typeof obj.entrypoint === 'string' && !s.entrypoint) s.entrypoint = obj.entrypoint;

  if (obj.type === 'user') {
    const text = extractText(obj.message?.content);
    if (text === null) return; // tool_result만 있는 기계 메시지
    // 붙여넣은 이미지(1MB 미만이라 스킵 안 된 라인): 사용자 메시지의 직접 image 블록
    if (Array.isArray(obj.message?.content)) {
      for (const c of obj.message.content as any[]) if (c && c.type === 'image') s.imageInputs++;
    }
    s.userMsgs++;
    if (text.includes('[Request interrupted')) s.interruptions++;
    const re = /<command-name>([^<]+)<\/command-name>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) s.slashCommands.push(m[1].trim());
    const clean = text.trim();
    // 사람 메시지가 나오기 전에 이어하기 스텁이 보이면 이 파일은 기존 대화의 연속이다
    if (!s.firstPrompt && clean.startsWith('This session is being continued')) s.isContinuation = true;
    // 사람이 직접 친 메시지만 질문 비율에 넣는다. 첫 메시지만 보면 긴 세션 중간의 질문이 전부 누락된다
    const isHuman = !!clean && !isMetaText(clean) && !clean.includes('[Request interrupted');
    if (isHuman) {
      s.humanMsgs++;
      if (AT_MENTION_RE.test(clean)) s.atMentions++;
      if (THINK_ESCALATE_RE.test(clean)) s.thinkEscalations++;
      // 작업 의도 키워드 집계 (세션 전체 사람 메시지 누적 → categorize가 사용)
      for (const it of INTENT_RES) {
        if (it.re.test(clean)) s.intentHits[it.name] = (s.intentHits[it.name] ?? 0) + 1;
      }
      const isQ = QUESTION_RE.test(clean);
      // 지시형 = 질문도, 단순 승인("응", "1번", "." 등)도 아닌 메시지. 80자 이상이면 맥락이 담긴 지시로 본다
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
        // 체인: 직전 사람 메시지도 질문이면 이어지는 중. 2에 닿는 순간과 3에 닿는 순간만 센다(체인당 1회)
        qState.run = qState.prevQ ? qState.run + 1 : 1;
        if (qState.run === 2) s.learning.chain2++;
        if (qState.run === 3) s.learning.chain3++;
      } else {
        qState.run = 0;
      }
      qState.prevQ = isQ;
    }
    if (!s.firstPrompt && isHuman) s.firstPrompt = clean.slice(0, 300);
  } else if (obj.type === 'assistant') {
    const msg = obj.message;
    if (!msg) return;
    const id =
      typeof msg.id === 'string' ? msg.id : typeof obj.uuid === 'string' ? obj.uuid : null;
    // 콘텐츠 블록은 같은 id의 여러 라인에 나뉘어 오므로, usage 중복 여부와 무관하게 매 라인에서 모은다
    let meta: MsgMeta | null = null;
    if (id) {
      meta = msgMeta.get(id) ?? null;
      if (!meta) {
        meta = { tools: [], exts: [], verbs: [], output: 0, total: 0 };
        msgMeta.set(id, meta);
      }
    }
    collectToolUse(msg.content, s, meta);
    if (id) {
      if (seenMessageIds.has(id)) return;
      seenMessageIds.add(id);
    }
    s.assistantMsgs++;
    if (msg.usage) {
      addUsage(s, typeof msg.model === 'string' ? msg.model : 'unknown', msg.usage);
      const u = msg.usage;
      const lineTotal =
        num(u.input_tokens) +
        num(u.output_tokens) +
        num(u.cache_read_input_tokens) +
        num(u.cache_creation_input_tokens);
      if (typeof obj.timestamp === 'string') {
        const t = Date.parse(obj.timestamp);
        if (!isNaN(t)) {
          const day = localDay(t);
          s.daily[day] = (s.daily[day] ?? 0) + lineTotal;
        }
      }
      if (meta) {
        meta.output += num(u.output_tokens);
        meta.total += lineTotal;
      }
    }
  }
}

function collectToolUse(content: unknown, s: SessionSummary, meta: MsgMeta | null): void {
  if (!Array.isArray(content)) return;
  for (const c of content as any[]) {
    if (!c || c.type !== 'tool_use' || typeof c.name !== 'string') continue;
    s.toolCounts[c.name] = (s.toolCounts[c.name] ?? 0) + 1;
    meta?.tools.push(c.name);
    const input = c.input && typeof c.input === 'object' ? c.input : {};
    // 백그라운드 실행: run_in_background=true 로 띄운 도구(Bash·Agent 등)
    if (input.run_in_background === true) s.backgroundRuns++;
    if (c.name === 'Edit' || c.name === 'Write' || c.name === 'NotebookEdit') {
      const fp =
        typeof input.file_path === 'string'
          ? input.file_path
          : typeof input.notebook_path === 'string'
            ? input.notebook_path
            : '';
      const dot = fp.lastIndexOf('.');
      if (dot > 0 && meta) meta.exts.push(fp.slice(dot + 1).toLowerCase());
    }
    if (c.name === 'Bash' && typeof input.command === 'string' && meta) {
      meta.verbs.push(...commandVerbs(input.command));
    }
    if (c.name === 'Skill' && typeof input.skill === 'string') {
      s.skillUses[input.skill] = (s.skillUses[input.skill] ?? 0) + 1;
    }
  }
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text as string);
    if (parts.length === 0) {
      const hasToolResult = content.some((c: any) => c && c.type === 'tool_result');
      return hasToolResult ? null : '';
    }
    return parts.join('\n');
  }
  return null;
}

function isMetaText(t: string): boolean {
  return (
    t.startsWith('<command-') ||
    t.startsWith('<local-command') ||
    t.includes('<command-name>') ||
    t.startsWith('<system-reminder') ||
    t.startsWith('<task-notification') ||
    t.startsWith('Caveat:') ||
    // 컨텍스트 초과로 이어진 세션 첫머리의 자동 요약 스텁 — 사람이 친 메시지가 아니다
    t.startsWith('This session is being continued')
  );
}

function addUsage(s: SessionSummary, model: string, u: any): void {
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const read = num(u.cache_read_input_tokens);
  const create = num(u.cache_creation_input_tokens);
  let c1h = 0;
  let c5m = 0;
  if (u.cache_creation && typeof u.cache_creation === 'object') {
    c1h = num(u.cache_creation.ephemeral_1h_input_tokens);
    c5m = num(u.cache_creation.ephemeral_5m_input_tokens);
  } else {
    c5m = create;
  }
  s.usage.input += input;
  s.usage.output += output;
  s.usage.cacheRead += read;
  s.usage.cacheCreate5m += c5m;
  s.usage.cacheCreate1h += c1h;

  const pm =
    s.perModel[model] ?? (s.perModel[model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  pm.input += input;
  pm.output += output;
  pm.cacheRead += read;
  pm.cacheCreate += c1h + c5m;
}
