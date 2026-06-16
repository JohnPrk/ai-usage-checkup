import { scanCodexJsonl, codexSessionDirs, ScannedCodexFile } from './scanner';
import { parseCodexSession } from './parser';
import { BaseAnalyzer } from '../provider';
import { buildCodexInventory } from './inventory';
import { buildCodexRecommendations, buildCodexScoreCriteria, buildCodexScores, categorizeCodex, CodexHeuristicInput } from './heuristics';
import { Behavior, CodexBehavior, CodexSession, Progress, Report } from '../types';

// GPT-5(Codex) USD / 1M tokens (참고치). cached input은 캐시 단가, 나머지 input은 일반 단가.
const GPT5_IN = 1.25;
const GPT5_CACHED = 0.125;
const GPT5_OUT = 10;

function localStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// Codex cwd는 Windows 경로(D:\)도 섞여 path.basename이 안 통하므로 구분자를 직접 가른다
function codexPlaceLabel(cwd: string | null): string {
  if (!cwd) return '알 수 없음';
  return cwd.split(/[\\/]/).filter(Boolean).pop() || '알 수 없음';
}

// Codex(OpenAI) 사용 로그(~/.codex/sessions/**.jsonl) 분석기.
export class CodexAnalyzer extends BaseAnalyzer<ScannedCodexFile, CodexSession> {
  readonly id = 'codex' as const;
  readonly label = 'Codex (OpenAI)';

  protected scan(days: number): ScannedCodexFile[] {
    return scanCodexJsonl(days);
  }

  protected async parseAll(
    files: ScannedCodexFile[],
    onProgress?: (p: Progress) => void
  ): Promise<{ sessions: CodexSession[]; skippedLines: number }> {
    const sessions: CodexSession[] = [];
    let done = 0;
    for (const f of files) {
      onProgress?.({ phase: '세션 파일 분석 중', done, total: files.length });
      try {
        sessions.push(await parseCodexSession(f));
      } catch {
        // 깨진 파일은 건너뛴다
      }
      done++;
    }
    sessions.sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
    return { sessions, skippedLines: 0 };
  }

  // Codex는 1파일=1세션이라 스킵 라인 개념이 없다(_skippedLines 미사용).
  protected aggregate(days: number, fileCount: number, sessions: CodexSession[], _skippedLines: number): Report {
    return aggregate(days, fileCount, sessions);
  }
}

// 기존 호출부 호환 래퍼 (main.ts·cli). 내부적으로 CodexAnalyzer.run 을 쓴다.
export function runCodexAnalysis(days: number, onProgress?: (p: Progress) => void): Promise<Report> {
  return new CodexAnalyzer().run(days, onProgress);
}

function aggregate(days: number, fileCount: number, all: CodexSession[]): Report {
  // 메시지가 없는 빈 세션은 제외
  const main = all.filter((s) => s.humanMsgs + s.toolChain > 0);
  for (const s of main) s.category = categorizeCodex(s);

  // 토큰: Codex total_token_usage 는 누적이라 세션당 마지막 값. input_tokens 안에 cached_input_tokens 가 포함된다.
  let tInput = 0;
  let tCached = 0;
  let tOutput = 0;
  let tTotal = 0;
  for (const s of main) {
    tInput += s.tokens.input;
    tCached += s.tokens.cachedInput;
    tOutput += s.tokens.output;
    tTotal += s.tokens.total || s.tokens.input + s.tokens.output;
  }
  const newInput = Math.max(0, tInput - tCached);
  const totals = {
    input: newInput,
    output: tOutput,
    cacheRead: tCached,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    all: tTotal,
  };
  const cacheHitRate = tInput > 0 ? tCached / tInput : 0;
  const recacheRate = 0; // Codex는 캐시 쓰기/재작성 구분이 없음(자동)
  const estCostUSD = (newInput * GPT5_IN + tCached * GPT5_CACHED + tOutput * GPT5_OUT) / 1e6;
  const estSavedUSD = (tCached * (GPT5_IN - GPT5_CACHED)) / 1e6;

  const modelMix = tTotal > 0 ? [{ model: 'GPT-5 (Codex)', tokens: tTotal, pct: 100 }] : [];

  // 작업 분류 (+ 분야 안에 실제 어느 폴더 세션이 몇 개인지 드릴다운)
  const catCount = new Map<string, number>();
  const catPlaces = new Map<string, Map<string, number>>();
  for (const s of main) {
    catCount.set(s.category, (catCount.get(s.category) ?? 0) + 1);
    const places = catPlaces.get(s.category) ?? new Map<string, number>();
    const place = codexPlaceLabel(s.cwd);
    places.set(place, (places.get(place) ?? 0) + 1);
    catPlaces.set(s.category, places);
  }
  const catEntries = [...catCount.entries()].sort((a, b) => b[1] - a[1]);
  let accPct = 0;
  const categories = catEntries.map(([name, n], i) => {
    const pct = i === catEntries.length - 1 ? Math.max(0, 100 - accPct) : Math.round((n / Math.max(1, main.length)) * 100);
    accPct += pct;
    const projects = [...(catPlaces.get(name) ?? new Map()).entries()]
      .map(([p, c]) => ({ name: p, sessions: c as number }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 4);
    return { name, sessions: n, pct, projects };
  });

  // 활동 분포 (Codex는 total=도구 호출 수)
  const actAgg = new Map<string, { msgs: number; output: number; total: number; details: Record<string, number> }>();
  for (const s of main) {
    for (const [name, a] of Object.entries(s.activities)) {
      const t = actAgg.get(name) ?? { msgs: 0, output: 0, total: 0, details: {} };
      t.msgs += a.msgs;
      t.output += a.output;
      t.total += a.total;
      for (const [k, v] of Object.entries(a.details ?? {})) t.details[k] = (t.details[k] ?? 0) + v;
      actAgg.set(name, t);
    }
  }
  const actTotal = [...actAgg.values()].reduce((a, t) => a + t.total, 0);
  const activities = [...actAgg.entries()]
    .map(([name, t]) => ({
      name,
      msgs: t.msgs,
      output: t.output,
      total: t.total,
      pct: actTotal > 0 ? Math.round((t.total / actTotal) * 100) : 0,
      details: Object.fromEntries(Object.entries(t.details).sort((a, b) => b[1] - a[1]).slice(0, 4)),
    }))
    .sort((a, b) => b.total - a.total);

  // 일별 토큰: 빈 날도 0으로 채워 연속 칸을 만든다
  const dailyAgg = new Map<string, number>();
  for (const s of main) for (const [day, t] of Object.entries(s.daily ?? {})) dailyAgg.set(day, (dailyAgg.get(day) ?? 0) + t);
  const daily: { date: string; tokens: number }[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    daily.push({ date: key, tokens: dailyAgg.get(key) ?? 0 });
  }

  // 도구 분포 + 성격별 그룹
  const toolAgg = new Map<string, number>();
  for (const s of main) for (const [name, n] of Object.entries(s.toolCounts)) toolAgg.set(name, (toolAgg.get(name) ?? 0) + n);
  const toolTop = [...toolAgg.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n).slice(0, 12);
  const TOOL_GROUP_RES: { label: string; re: RegExp }[] = [
    { label: '터미널', re: /^(exec_command|shell_command|write_stdin)$/ },
    { label: '파일 수정', re: /^apply_patch$/ },
    { label: '웹 검색', re: /^web_search$/ },
    { label: '계획·목표', re: /^(update_plan|create_goal|update_goal)$/ },
    { label: 'MCP 연동', re: /^(_|mcp)/ },
  ];
  const groupTotals = new Map<string, number>();
  let toolCallTotal = 0;
  for (const [name, n] of toolAgg) {
    toolCallTotal += n;
    const label = TOOL_GROUP_RES.find((x) => x.re.test(name))?.label ?? '기타';
    groupTotals.set(label, (groupTotals.get(label) ?? 0) + n);
  }
  const toolGroups = [...groupTotals.entries()]
    .map(([label, n]) => ({ label, n, pct: toolCallTotal > 0 ? Math.round((n / toolCallTotal) * 100) : 0 }))
    .sort((a, b) => b.n - a.n);

  // ── 행동 집계 → CodexBehavior ──────────────────────────────────────
  const sum = (f: (s: CodexSession) => number): number => main.reduce((a, s) => a + f(s), 0);
  const humanMsgs = sum((s) => s.humanMsgs);
  const directiveMsgs = sum((s) => s.directiveMsgs);
  const substantive = sum((s) => s.substantiveDirectives);
  const fileRef = sum((s) => s.fileRefDirectives);
  const verifyDir = sum((s) => s.verifyDirectives);
  const questionMsgs = sum((s) => s.questionMsgs);
  const taskStarted = sum((s) => s.taskStarted);
  const taskComplete = sum((s) => s.taskComplete);
  const aborts = sum((s) => s.aborted + s.rolledBack);
  const toolChainTotal = sum((s) => s.toolChain);
  const applyPatches = sum((s) => s.applyPatches);
  const execRuns = sum((s) => s.execRuns);
  const verifyRuns = sum((s) => s.verifyRuns);
  const planUses = sum((s) => s.planUses);
  const goalUses = sum((s) => s.goalUses);
  const webSearches = sum((s) => s.webSearches);
  const mcpCalls = sum((s) => s.mcpCalls);
  const skillMentions = sum((s) => s.skillMentions);
  const writeStdins = sum((s) => s.writeStdins);
  const atMentions = sum((s) => s.atMentions);

  // 학습 주도성(공용 축): 질문 패턴 100메시지당 + 질문 비율 + 학습 세션 비중
  const lsum = { chain2: 0, chain3: 0, grabQs: 0, whyQs: 0, confirmQs: 0 };
  for (const s of main) {
    lsum.chain2 += s.learning.chain2;
    lsum.chain3 += s.learning.chain3;
    lsum.grabQs += s.learning.grabQs;
    lsum.whyQs += s.learning.whyQs;
    lsum.confirmQs += s.learning.confirmQs;
  }
  const per100 = (v: number) => (humanMsgs > 0 ? (v / humanMsgs) * 100 : 0);
  const learningSignals = {
    chainPer100: per100(lsum.chain2),
    chain3Per100: per100(lsum.chain3),
    grabPer100: per100(lsum.grabQs),
    whyPer100: per100(lsum.whyQs),
    confirmPer100: per100(lsum.confirmQs),
  };
  const questionRatio = humanMsgs > 0 ? questionMsgs / humanMsgs : 0;
  // Codex는 토큰 귀속이 불가능해 학습 '양'은 '학습·이해' 세션 비중으로 근사한다 (categorizeCodex가 위에서 분류 완료)
  const studyShare = main.length > 0 ? main.filter((s) => s.category === '학습·이해').length / main.length : 0;

  const promptLens = main.filter((s) => s.firstPrompt).map((s) => s.firstPrompt.length).sort((a, b) => a - b);
  const medianFirstPromptLen = promptLens.length ? promptLens[Math.floor(promptLens.length / 2)] : 0;
  const withDuration = main.filter((s) => s.durationMin > 0);
  const avgSessionMin = withDuration.length ? withDuration.reduce((a, s) => a + s.durationMin, 0) / withDuration.length : 0;
  const patchSessions = main.filter((s) => s.applyPatches > 0);
  const verifyAfterPatchShare =
    patchSessions.length > 0 ? patchSessions.filter((s) => s.verifyRuns > 0).length / patchSessions.length : 0;
  const planSessions = main.filter((s) => s.planUses > 0 || s.goalUses > 0).length;
  // 오류 회복·수렴(공용 축): function_call_output 실패가 난 세션 중 끝까지 해결(이후 성공으로 닫힘)된 비율
  const failSessionList = main.filter((s) => s.toolFailures > 0);
  const failureSessions = failSessionList.length;
  const unresolvedFailSessions = failSessionList.filter((s) => s.toolFailures - s.toolFailuresResolved > 0).length;
  // 균등가중 미해결 비율: 세션별 (미해결/실패)의 평균 — 실패 1개를 통째로 버린 세션을 세게(=1) 잡는다.
  const meanUnresolvedShare = failureSessions > 0
    ? failSessionList.reduce((a, s) => a + (s.toolFailures - s.toolFailuresResolved) / s.toolFailures, 0) / failureSessions
    : 0;
  const failureEvents = main.reduce((a, s) => a + s.toolFailures, 0);

  const cb: CodexBehavior = {
    sessions: main.length,
    humanMsgs,
    medianFirstPromptLen,
    substantiveDirectiveShare: directiveMsgs > 0 ? substantive / directiveMsgs : 0,
    fileRefDirectiveShare: directiveMsgs > 0 ? fileRef / directiveMsgs : 0,
    verifyDirectiveShare: directiveMsgs > 0 ? verifyDir / directiveMsgs : 0,
    abortPer100: humanMsgs > 0 ? (aborts / humanMsgs) * 100 : 0,
    avgSessionMin,
    questionRatio,
    learningSignals,
    learnUsageShare: studyShare,
    taskCompletionRate: taskStarted > 0 ? Math.min(1, taskComplete / taskStarted) : 0,
    avgToolChain: taskStarted > 0 ? toolChainTotal / taskStarted : 0,
    aborts,
    failureSessions,
    unresolvedFailSessions,
    meanUnresolvedShare,
    failureEvents,
    applyPatches,
    verifyAfterPatchShare,
    verifyRunShare: execRuns > 0 ? verifyRuns / execRuns : 0,
    planSessionShare: main.length > 0 ? planSessions / main.length : 0,
    planUses,
    goalUses,
    webSearches,
    mcpCalls,
    skillMentions,
  };

  // 인벤토리 (자주 쓰는 프로젝트 상위 + 스킬 멘션 횟수)
  const byProject = new Map<string, CodexSession[]>();
  for (const s of main) {
    const key = codexPlaceLabel(s.cwd);
    const list = byProject.get(key) ?? [];
    list.push(s);
    byProject.set(key, list);
  }
  const topProjects = [...byProject.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 6)
    .flatMap(([project, list]) => {
      const cwd = list.find((s) => s.cwd)?.cwd;
      return cwd ? [{ project, cwd }] : [];
    });
  const skillUseCount = new Map<string, number>();
  for (const s of main) for (const [k, v] of Object.entries(s.skillUses)) skillUseCount.set(k, (skillUseCount.get(k) ?? 0) + v);
  const { inventory, mcpServers, plugins } = buildCodexInventory(topProjects, skillUseCount);

  // ── featureCoverage (Codex 기능) ─────────────────────────────────────
  const graded = (count: number): { used: boolean; adopt: number; detail: string } => {
    if (count <= 0) return { used: false, adopt: 0, detail: '' };
    if (count >= 10) return { used: true, adopt: 1, detail: `${count.toLocaleString()}회` };
    if (count >= 5) return { used: true, adopt: 0.7, detail: `${count}회` };
    return { used: true, adopt: 0.4, detail: `${count}회` };
  };
  const config = (count: number, unit: '보유' | '개'): { used: boolean; adopt: number; detail: string } =>
    count > 0 ? { used: true, adopt: 1, detail: unit === '개' ? `${count}개` : '보유' } : { used: false, adopt: 0, detail: '' };
  const autoTag = (g: { used: boolean; adopt: number; detail: string }) => (g.used ? { ...g, detail: `${g.detail} · 자동` } : g);
  const feat = (name: string, g: { used: boolean; adopt: number; detail: string }, weight: number) => ({
    name,
    used: g.used,
    weight,
    adopt: g.adopt,
    detail: g.detail,
  });
  // 외부 서비스 CLI 사용(터미널 명령 첫 단어)
  const CLI_TOOLS = new Set(['gh', 'aws', 'gcloud', 'az', 'supabase', 'vercel', 'netlify', 'kubectl', 'terraform', 'docker', 'flyctl', 'wrangler', 'heroku']);
  const cliToolUses = Object.entries(actAgg.get('명령 실행')?.details ?? {}).reduce((a, [v, n]) => a + (CLI_TOOLS.has(v) ? n : 0), 0);
  const hasAgents = inventory.globalClaudeMd.exists || inventory.projectClaudeMds.some((p) => p.has);
  const featureCoverage: Report['featureCoverage'] = [
    feat('AGENTS.md', config(hasAgents ? 1 : 0, '보유'), 1),
    feat('스킬', graded(skillMentions), 1),
    feat('훅', config(inventory.hooks.length, '개'), 1),
    feat('MCP', config(mcpServers, '개'), 1),
    feat('플러그인', config(plugins, '개'), 1),
    feat('계획·목표 도구', graded(planUses + goalUses), 1),
    feat('웹 검색', autoTag(graded(webSearches)), 0.4),
    feat('대화형 실행', autoTag(graded(writeStdins)), 0.4),
    feat('외부 CLI', graded(cliToolUses), 1),
  ];

  const skillUsesList = inventory.skills.map((s) => s.uses);
  const skillUseTotal = skillUsesList.reduce((a, n) => a + n, 0);
  const skillConcentration = skillUseTotal > 0 ? Math.max(...skillUsesList) / skillUseTotal : 0;

  const hin: CodexHeuristicInput = {
    behavior: cb,
    inventory,
    featureCoverage: featureCoverage ?? [],
    skillConcentration,
    skillUseTotal,
  };
  const scores = buildCodexScores(hin);
  const recommendations = buildCodexRecommendations(hin);

  // Report.behavior(Behavior 타입)에 Codex 값을 매핑. renderer가 직접 읽는 건 interruptions·avgSessionMin뿐.
  const behavior: Behavior = {
    interruptions: aborts,
    subagentRuns: 0,
    compactSessions: 0,
    longNoCompactSessions: 0,
    avgSessionMin,
    medianFirstPromptLen,
    humanMsgs,
    directiveMsgs,
    substantiveDirectiveShare: cb.substantiveDirectiveShare,
    fileRefDirectiveShare: cb.fileRefDirectiveShare,
    verifyDirectiveShare: cb.verifyDirectiveShare,
    failureSessions,
    unresolvedFailSessions,
    meanUnresolvedShare,
    failureEvents,
    escPer100: cb.abortPer100,
    questionRatio: humanMsgs > 0 ? questionMsgs / humanMsgs : 0,
    clearCompactCommands: 0,
    correctionStormSessions: 0,
    mcpToolCalls: mcpCalls,
    cliToolUses,
    initCommands: 0,
    loopCommands: 0,
    thinkEscalations: 0,
    imageInputs: 0,
    backgroundRuns: 0,
    atMentions,
    cheaperModelShare: 0,
    learningSignals,
    topCommands: [],
    claudeMd: [],
  };

  // 코칭 샘플
  const samples: Report['samples'] = [];
  const perProjectCount = new Map<string, number>();
  for (const s of main) {
    if (samples.length >= 12) break;
    if (!s.firstPrompt || s.firstPrompt.length < 10) continue;
    const key = codexPlaceLabel(s.cwd);
    const c = perProjectCount.get(key) ?? 0;
    if (c >= 3) continue;
    perProjectCount.set(key, c + 1);
    samples.push({ project: key, category: s.category, prompt: s.firstPrompt.slice(0, 200) });
  }

  return {
    generatedAt: localStamp(),
    days,
    files: fileCount,
    sessions: main.length,
    skippedLines: 0,
    totals,
    cacheHitRate,
    recacheRate,
    estCostUSD,
    estSavedUSD,
    modelMix,
    categories,
    activities,
    daily,
    toolTop,
    toolGroups,
    inventory,
    featureCoverage,
    behavior,
    scores,
    scoreCriteria: buildCodexScoreCriteria(),
    recommendations,
    samples,
    env: { claudeBinary: null, projectsDirs: codexSessionDirs() },
  };
}
