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
}

export interface SessionSummary {
  file: string;
  projectDir: string;
  isSubagentFile: boolean;
  category: string;
  firstPrompt: string;
  firstTs: number | null;
  lastTs: number | null;
  durationMin: number;
  userMsgs: number;
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
  questionRatio: number;
  topCommands: { cmd: string; n: number }[];
  claudeMd: { project: string; cwd: string; has: boolean }[];
}

export interface Inventory {
  globalClaudeMd: { exists: boolean; bytes: number };
  projectClaudeMds: { project: string; cwd: string; has: boolean; bytes: number }[];
  skills: { name: string; description: string; uses: number }[];
  hooks: { event: string; matcher: string; command: string }[];
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
  categories: { name: string; sessions: number; pct: number }[];
  activities: { name: string; msgs: number; output: number; total: number; pct: number }[];
  toolTop: { name: string; n: number }[];
  inventory: Inventory;
  behavior: Behavior;
  scores: { axis: string; score: number }[];
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
