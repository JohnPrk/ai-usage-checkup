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
  featureCoverage?: { name: string; used: boolean }[];
  behavior: Behavior;
  // desc/detail: 축이 뭘 재는지 한 줄 + 이번 측정의 실제 입력값 (구버전 스냅샷에는 없음)
  scores: { axis: string; score: number; desc?: string; detail?: string }[];
  // 점수 기준 팝업 내용. 스냅샷에 같이 저장돼 그 시점의 기준이 남는다 (구버전 스냅샷에는 없음)
  scoreCriteria?: AxisCriterion[];
  recommendations: Rec[];
  samples: { project: string; category: string; prompt: string }[];
  env: { claudeBinary: string | null; projectsDirs: string[] };
}

// 홈 화면 이전 결과 목록 항목
export interface SnapshotMeta {
  date: string;
  sessions: number;
  totalTokens: number;
  avgScore: number;
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
