export interface UsageSum {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
}

export interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

// 한 어시스턴트 메시지를 도구·파일 확장자 기준으로 분류한 활동의 누적치
export interface ActivityCount {
  msgs: number;
  output: number;
  total: number;
  // 활동의 실제 내용물 상위 항목 (확장자 또는 명령어 첫 단어 → 횟수)
  details: Record<string, number>;
}

export interface SessionSummary {
  file: string;
  projectDir: string;
  isSubagentFile: boolean;
  isContinuation: boolean; // 컨텍스트 초과로 이어진 파일 — 첫 메시지가 세션 시작이 아니므로 첫 메시지 통계에서 제외
  isForkChild: boolean; // 포크·워크트리 사본 — 시작 구간이 다른 파일에서 이미 집계된 파일. 고유 라인만 집계되고 세션 수에서 빠진다
  rootUuid: string | null; // 파일 첫 라인의 uuid. 같은 대화에서 갈라진 파일들은 이 값이 같다 (그룹 머지 키)
  category: string;
  firstPrompt: string;
  // 세션 전체 사람 메시지에서 모은 작업 의도 키워드 점수. categorize가 디렉토리·첫 문장 대신 이걸로 분류한다
  intentHits: Record<string, number>;
  firstTs: number | null;
  lastTs: number | null;
  durationMin: number;
  userMsgs: number;
  humanMsgs: number; // 사람이 직접 친 메시지 수 (중단 마커·커맨드 래퍼 등 기계 텍스트 제외)
  questionMsgs: number; // humanMsgs 중 질문형 메시지 수
  directiveMsgs: number; // humanMsgs 중 지시형(질문·단순 승인 제외) 메시지 수
  substantiveDirectives: number; // 지시형 중 80자 이상 — 맥락·제약이 담긴 지시의 근사
  fileRefDirectives: number; // 지시형 중 구체 파일·경로·@ 를 지목 (Best Practices "Reference specific files")
  verifyDirectives: number; // 지시형 중 테스트·빌드·검증 실행을 함께 요청 (Best Practices "verify its work")
  // 공식 기능 활용 신호 (2026-06-14): 확장 사고·이미지·백그라운드·@ 멘션
  thinkEscalations: number; // ultrathink 등 '의도적 심화 사고' 요청 수 (늘 켜둔 자동 thinking은 제외)
  imageInputs: number; // 사용자가 붙여넣은 이미지 블록 수 (tool_result 스크린샷은 제외)
  backgroundRuns: number; // run_in_background=true 로 띄운 도구 실행 수
  atMentions: number; // @경로 파일 멘션이 들어간 사람 메시지 수
  // 오류 회복·수렴 신호(공용 축): 도구가 실패했을 때 끝까지 잡아 해결했는가
  toolFailures: number; // is_error=true 인 tool_result 수 (도구 실행 실패)
  toolFailuresResolved: number; // 그중 이후 성공 도구결과로 닫힌 수 (남은 = 미해결로 끝남)
  // (legacy) 검증 신호: '테스트를 돌렸나'. 오류 회복 축으로 대체돼 점수엔 안 쓰지만 파싱은 유지(스냅샷 호환·표시용)
  verifyRuns: number; // Bash 명령 중 test·build·lint 성격(VERIFY_CMD_RE) 실행 수
  // 학습 주도성 신호: 받은 답을 그대로 두지 않는 행동의 횟수
  learning: {
    chain2: number; // 2연속 질문 체인 (꼬리질문 시작)
    chain3: number; // 3연속 이상으로 이어진 체인 (깊이)
    grabQs: number; // "근데/그럼/그렇다면"으로 직전 답변을 받아 되묻는 질문
    whyQs: number; // 왜·이유·원리·차이를 묻는 질문
    confirmQs: number; // "그러니까 ~라는 거지?" 이해 확인형
  };
  assistantMsgs: number;
  usage: UsageSum;
  perModel: Record<string, ModelUsage>;
  interruptions: number;
  compacts: number;
  slashCommands: string[];
  hasSidechain: boolean;
  cwd: string | null;
  entrypoint: string | null;
  toolCounts: Record<string, number>;
  skillUses: Record<string, number>;
  activities: Record<string, ActivityCount>;
  daily: Record<string, number>; // 'YYYY-MM-DD'(로컬) → 그날 쓴 총 토큰
}

// 점수 기준의 근거 출처 (공식 문서·연구). 축마다 0개 이상
export interface AxisSource {
  label: string; // 출처 이름 (예: 'Claude Code Best Practices')
  url: string; // 링크
  grounds: string; // 이 출처가 뒷받침하는 내용 한 줄
}

// 점수 기준 팝업용: 각 축의 공식을 사람이 읽는 문장으로 풀어둔 것 (heuristics.buildScoreCriteria)
export interface AxisCriterion {
  axis: string;
  what: string; // 뭘 재는지 한 줄
  base: string; // 시작점
  gains: string[]; // 가점 조건 (만점 기준 포함)
  penalties: string[]; // 감점 조건 (없으면 빈 배열)
  sources?: AxisSource[]; // 원리·신호 선택의 근거 출처 (구버전 스냅샷에는 없음)
  calibrationNote?: string; // 임계값 숫자가 출처가 아닌 자체 앵커임을 밝히는 단서 (구버전 스냅샷에는 없음)
}

// 세부 수치 팝업의 한 줄: 왼쪽 라벨(무엇을·어떻게 채점) + 오른쪽 값. (구버전 스냅샷에는 없음 → detail 문자열로 폴백)
export interface ScoreMetric {
  label: string; // 무엇을 쟀는가 (왼쪽)
  value: string; // 측정값 (오른쪽 정렬, 예: '28%', '41개')
  hint?: string; // 어떻게 점수에 반영되는가 (라벨 아래 작은 글씨)
}

export interface Rec {
  id: string;
  severity: 'high' | 'mid';
  title: string;
  now: string;
  better: string;
  script: string;
}

export interface Behavior {
  interruptions: number;
  subagentRuns: number;
  compactSessions: number;
  longNoCompactSessions: number;
  avgSessionMin: number;
  medianFirstPromptLen: number;
  humanMsgs: number; // 기간 내 사람이 친 전체 메시지 수 (per-100 정규화 분모)
  directiveMsgs: number; // 지시형 메시지 수
  substantiveDirectiveShare: number; // 지시형 중 80자 이상 비중 — 세션 중간에도 맥락을 담아 지시하는가
  fileRefDirectiveShare: number; // 지시 중 구체 파일·경로·@ 지목 비중 (구체성 보강 신호)
  verifyDirectiveShare: number; // 지시 중 테스트·빌드·검증 실행을 함께 요청한 비중 (구체성 보강 신호)
  // 오류 회복·수렴 축(공용): 도구 실패를 끝까지 해결했는가
  failureSessions: number; // is_error/비0 종료가 1회+ 난 세션 수 (회복력 표본)
  unresolvedFailSessions: number; // 그중 실패를 해결 못한 채 끝난 세션 수
  meanUnresolvedShare: number; // 실패 세션별 (미해결/실패) 평균 — 버릴 때 통째로 버리는 '심각도'(균등가중)
  failureEvents: number; // 실패 이벤트 총수 (표시·표본용)
  escPer100: number; // 사람 메시지 100개당 Esc 중단 횟수
  questionRatio: number; // 사람이 친 전체 메시지 중 질문형 비율 (학습 주도성의 보조 신호)
  // 컨텍스트 위생 보강 (Best Practices "/clear between tasks", 실패패턴 "correcting over and over")
  clearCompactCommands: number; // /clear·/compact 슬래시 커맨드 총 사용 수
  correctionStormSessions: number; // 한 세션에서 3회 이상 중단·정정한 세션 수 (컨텍스트 오염)
  // 도구 생태계·비용 보강 (Best Practices "Configure your environment", agent-design cheaper model)
  mcpToolCalls: number; // MCP 도구 호출 수
  cliToolUses: number; // gh·aws·gcloud 등 외부 서비스 CLI 사용 수
  initCommands: number; // /init 사용 수
  loopCommands: number; // /loop(반복 실행) 사용 수
  // 공식 기능 활용 신호 (2026-06-14): 기간 합산
  thinkEscalations: number; // 의도적 심화 사고(ultrathink 등) 요청 총 수
  imageInputs: number; // 붙여넣은 이미지 입력 총 수
  backgroundRuns: number; // 백그라운드 실행 총 수
  atMentions: number; // @ 파일 멘션이 든 사람 메시지 총 수
  cheaperModelShare: number; // 전체 토큰 중 저렴 모델(Haiku) 비중 — 싼 작업 위임
  // 학습 주도성 신호, 사람 메시지 100개당 횟수로 정규화
  learningSignals: {
    chainPer100: number;
    chain3Per100: number;
    grabPer100: number;
    whyPer100: number;
    confirmPer100: number;
  };
  topCommands: { cmd: string; n: number }[];
  claudeMd: { project: string; cwd: string; has: boolean }[];
}

export interface Inventory {
  globalClaudeMd: { exists: boolean; bytes: number };
  projectClaudeMds: { project: string; cwd: string; has: boolean; bytes: number; foundAt?: string }[];
  skills: { name: string; description: string; uses: number }[];
  hooks: { event: string; matcher: string; command: string }[];
  customCommands?: number; // ~/.claude/commands 의 커스텀 슬래시 커맨드 수 (구버전 스냅샷엔 없음)
}

// 익명 랭킹 RPC(submit_and_rank/get_rank) 응답
export interface RankResult {
  total: number; // 전체 표본 수
  below: number; // 내 아래 순위 인원(동점은 내 위로 치지 않음 → 동점이면 내가 그 그룹 1위)
  percentile: number | null; // 0~1, 나 포함 "나 이하" 비율(동점은 높은 쪽). null = 표본 0
}

// 클라(renderer)에 내려가는 순위 뷰: 서버 응답 + main 에서 계산한 티어/상위%.
// renderer 는 번들러 없이 전역 스크립트라 tier.ts 를 못 쓰므로 여기서 미리 채워 보낸다.
export interface RankView extends RankResult {
  tier?: { key: string; name: string; color: string }; // main 이 percentile 로 항상 채워 보냄(표본 적어도)
  topPct?: number; // 내 상위 % (반올림 전 원값)
}

// 리더보드 한 행: 등수 + 닉네임 + 평균점수 (+ 행별 티어 매핑용 percentile, 내 행 여부)
export interface LeaderboardRow {
  rnk: number;
  name: string;
  avg: number;
  percentile: number; // 0~1 (cume_dist). main 이 이 값으로 행별 티어를 계산한다
  isMe?: boolean;
}
// 서버 리더보드 RPC 응답: 상위 N + 내 행(없으면 null)
export interface LeaderboardResult {
  total: number;
  top: LeaderboardRow[];
  me: LeaderboardRow | null;
}
// renderer 에 내려가는 뷰: 각 행에 main 이 계산한 티어(엠블럼 키)를 붙인다
export interface LeaderboardRowView extends LeaderboardRow {
  tier?: { key: string; name: string; color: string };
}
export interface LeaderboardView {
  total: number;
  top: LeaderboardRowView[];
  me: LeaderboardRowView | null;
}

export interface Report {
  generatedAt: string;
  days: number;
  files: number;
  sessions: number;
  skippedLines: number;
  totals: UsageSum & { all: number };
  cacheHitRate: number;
  recacheRate: number;
  estCostUSD: number;
  estSavedUSD: number;
  modelMix: { model: string; tokens: number; pct: number }[];
  // projects: 이 분야로 분류된 세션들이 실제 어느 폴더에서 열렸는지 (구버전 스냅샷에는 없음)
  categories: { name: string; sessions: number; pct: number; projects?: { name: string; sessions: number }[] }[];
  // 세션이 열린 폴더의 '결'별 비중 (우테코 미션 / 개인 프로젝트 / 기타). 구버전 스냅샷에는 없음
  projectTypes?: { label: string; sessions: number; pct: number; projects?: { name: string; sessions: number }[] }[];
  activities: { name: string; msgs: number; output: number; total: number; pct: number; details?: Record<string, number> }[];
  // 일별 총 토큰 (구버전 스냅샷에는 없음)
  daily?: { date: string; tokens: number }[];
  toolTop: { name: string; n: number }[];
  // 도구를 성격별로 묶은 비중 (전체 호출 기준, 구버전 스냅샷에는 없음)
  toolGroups?: { label: string; n: number; pct: number }[];
  inventory: Inventory;
  // 공식 Claude Code 기능 중 기간 내 사용 여부 (구버전 스냅샷에는 없음)
  featureCoverage?: { name: string; used: boolean; weight?: number; adopt?: number; detail?: string }[];
  behavior: Behavior;
  // desc: 축이 뭘 재는지 한 줄. metrics: 세부 수치(라벨+값+힌트). detail: 구버전 스냅샷의 한 줄 문자열(폴백용)
  scores: { axis: string; score: number; desc?: string; detail?: string; metrics?: ScoreMetric[] }[];
  // 점수 기준 팝업 내용. 스냅샷에 같이 저장돼 그 시점의 기준이 남는다 (구버전 스냅샷에는 없음)
  scoreCriteria?: AxisCriterion[];
  recommendations: Rec[];
  samples: { project: string; category: string; prompt: string }[];
  // 익명 랭킹 결과 (동의하고 전송한 경우만 채워짐)
  rank?: RankView;
  env: { claudeBinary: string | null; projectsDirs: string[] };
}

// 홈 화면 이전 결과 목록 항목
export interface SnapshotMeta {
  date: string;
  sessions: number;
  totalTokens: number;
  avgScore: number;
  source: 'claude' | 'codex'; // 어떤 도구의 분석본인지 (이전 결과·추이선에서 구분)
}

export interface Coaching {
  status: 'ok' | 'not_logged_in' | 'no_binary' | 'error';
  message?: string;
  summary?: string;
  recommendations?: { title: string; now: string; better: string; script: string }[];
  promptRewrites?: { original: string; score: number; better: string }[];
}

export interface Progress {
  phase: string;
  done: number;
  total: number;
}

// ── Codex(OpenAI) 전용 ──────────────────────────────────────────────
// Codex rollout jsonl 한 세션(파일 1개 = 1세션) 파싱 결과. Claude의 SessionSummary와
// 목적은 같지만 신호가 다르다(자율 실행·apply_patch·plan·web_search 등). codex/analyze가 Report로 집계한다.
export interface CodexSession {
  file: string;
  cwd: string | null;
  originator: string | null; // 'Codex Desktop' | 'codex_vscode' | 'codex_cli'
  category: string;
  firstPrompt: string;
  intentHits: Record<string, number>;
  firstTs: number | null;
  lastTs: number | null;
  durationMin: number;
  // 사람 입력 (event_msg user_message)
  userMsgs: number;
  humanMsgs: number;
  questionMsgs: number;
  directiveMsgs: number;
  substantiveDirectives: number; // 80자 이상 지시
  fileRefDirectives: number; // 파일·경로·@ 지목 지시
  verifyDirectives: number; // 테스트·빌드·검증 실행을 함께 요청한 지시
  atMentions: number;
  skillMentions: number; // user_message의 [$skill](...) 멘션 수
  // 학습 주도성 신호(공용 축, Claude parser와 동일 로직): 받은 답을 그대로 두지 않는 질문 패턴
  learning: { chain2: number; chain3: number; grabQs: number; whyQs: number; confirmQs: number };
  // 자율 실행
  taskStarted: number; // event_msg task_started
  taskComplete: number; // event_msg task_complete
  aborted: number; // event_msg turn_aborted (사용자 중단)
  rolledBack: number; // event_msg thread_rolled_back
  toolChain: number; // 도구 호출 총합 (턴당 연쇄 길이의 분자)
  // 오류 회복·수렴(공용 축): function_call_output 의 비0 종료/실패를 이후 성공으로 닫았는가
  toolFailures: number; // exited with code N(≠0) 또는 success:false 인 function_call_output 수
  toolFailuresResolved: number; // 그중 이후 성공 도구결과로 닫힌 수
  // (legacy) 검증
  applyPatches: number; // custom_tool_call apply_patch (코드 편집)
  execRuns: number; // exec_command + shell_command
  verifyRuns: number; // 그중 test·build·lint 명령
  // 계획·구조화
  planUses: number; // update_plan
  goalUses: number; // create_goal + update_goal
  // 자산·기능
  webSearches: number; // web_search_call (내장 웹검색)
  mcpCalls: number; // MCP function_call (_*)
  writeStdins: number; // write_stdin (대화형 프로세스 조작)
  reasoningCount: number; // reasoning response_item (GPT-5 추론)
  skillUses: Record<string, number>; // user_message에서 멘션된 스킬 이름별 횟수
  // 토큰 (세션 마지막 total_token_usage 누적값)
  tokens: { input: number; cachedInput: number; output: number; reasoning: number; total: number };
  // 도구·활동·일별
  toolCounts: Record<string, number>; // function_call/custom_tool_call name 별 카운트
  activities: Record<string, ActivityCount>; // Codex는 토큰 귀속이 어려워 total=도구 호출 수로 집계
  daily: Record<string, number>; // 'YYYY-MM-DD'(로컬) → 그날 증분 토큰(last_token_usage 합)
}

// Codex 5축 점수 계산 입력(codex/heuristics.buildCodexScores). analyze가 세션 집계로 채운다.
export interface CodexBehavior {
  sessions: number;
  humanMsgs: number;
  medianFirstPromptLen: number;
  substantiveDirectiveShare: number;
  fileRefDirectiveShare: number;
  verifyDirectiveShare: number;
  abortPer100: number; // 사람 메시지 100개당 중단+롤백
  avgSessionMin: number;
  // 학습 주도성(공용 축): 질문 패턴 100메시지당 + 질문 비율 + 학습에 쓰는 비중
  questionRatio: number;
  learningSignals: { chainPer100: number; chain3Per100: number; grabPer100: number; whyPer100: number; confirmPer100: number };
  learnUsageShare: number; // Codex는 '학습·이해' 세션 비중 기반(토큰 귀속 불가)
  // 자율 실행
  taskCompletionRate: number; // task_complete / task_started
  avgToolChain: number; // task당 평균 도구 호출 수
  aborts: number; // 중단+롤백 총수(표시용)
  // 오류 회복·수렴(공용 축): function_call_output 실패를 이후 성공으로 닫았는가
  failureSessions: number; // 비0 종료/실패가 1회+ 난 세션 수 (회복력 표본)
  unresolvedFailSessions: number; // 그중 실패를 해결 못한 채 끝난 세션 수
  meanUnresolvedShare: number; // 실패 세션별 (미해결/실패) 평균 — 버릴 때 통째로 버리는 '심각도'(균등가중)
  failureEvents: number; // 실패 이벤트 총수 (표시·표본용)
  // (legacy) 검증
  applyPatches: number;
  verifyAfterPatchShare: number; // 코드 수정이 있는 세션 중 검증 명령을 함께 돌린 비율
  verifyRunShare: number; // exec 중 test·build·lint 비율
  // 계획·구조화
  planSessionShare: number; // update_plan/goal을 쓴 세션 비율
  planUses: number;
  goalUses: number;
  // 자산·기능
  webSearches: number;
  mcpCalls: number;
  skillMentions: number;
}
