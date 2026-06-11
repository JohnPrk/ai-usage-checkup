import * as fs from 'fs';
import * as path from 'path';
import { scanJsonl } from './scanner';
import { parseSession } from './parser';
import { buildRecommendations, buildScoreCriteria, buildScores, categorize, placeLabel, projectKind } from './heuristics';
import { buildInventory } from './inventory';
import { findClaude } from './llm';
import { claudeProjectDirs } from './paths';
import { Behavior, Progress, Report, SessionSummary } from './types';

// USD / 1M tokens. 캐시 읽기 = input의 0.1배, 캐시 쓰기 = 1.25배(5분) / 2배(1시간)
const PRICES: { match: RegExp; inUSD: number; outUSD: number }[] = [
  { match: /fable/i, inUSD: 10, outUSD: 50 },
  { match: /opus/i, inUSD: 5, outUSD: 25 },
  { match: /sonnet/i, inUSD: 3, outUSD: 15 },
  { match: /haiku/i, inUSD: 1, outUSD: 5 },
];

function priceOf(model: string): { inUSD: number; outUSD: number } {
  for (const p of PRICES) if (p.match.test(model)) return p;
  return { inUSD: 3, outUSD: 15 };
}

export async function runAnalysis(days: number, onProgress?: (p: Progress) => void): Promise<Report> {
  const files = scanJsonl(days);
  // 포크·워크트리 사본의 공유 구간을 원본(먼저 생긴 파일)이 선점하도록 오래된 순으로 처리한다
  const ordered = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const seenUuids = new Set<string>();
  const sessions: SessionSummary[] = [];
  let skippedLines = 0;
  let done = 0;
  for (const f of ordered) {
    onProgress?.({ phase: '세션 파일 분석 중', done, total: files.length });
    try {
      const { session, skippedLines: sk } = await parseSession(f, seenUuids);
      skippedLines += sk;
      sessions.push(session);
    } catch {
      // 깨진 파일은 건너뛴다
    }
    done++;
  }
  // 코칭 샘플은 최신 세션부터 뽑으므로 최신순으로 되돌린다
  sessions.sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
  onProgress?.({ phase: '집계 중', done: files.length, total: files.length });
  return aggregate(days, files.length, sessions, skippedLines);
}

function aggregate(days: number, fileCount: number, all: SessionSummary[], skippedLines: number): Report {
  // 메시지가 하나도 없는 파일(ai-title 사이드카, dedupe 후 빈 포크 사본 등)은 세션으로 치지 않는다
  const main = all.filter((s) => !s.isSubagentFile && s.userMsgs + s.assistantMsgs > 0);
  // 세션 수·세션 단위 지표는 대화를 시작한 파일만 센다. 이어하기·포크 꼬리의 고유 라인은 main을 통해 집계에 남는다
  const starters = main.filter((s) => !s.isContinuation && !s.isForkChild);
  for (const s of starters) s.category = categorize(s);

  // 꼬리 파일의 compact·시간 기록을 같은 대화(첫 라인 uuid가 같은 그룹)의 시작 파일로 합친다.
  // 시작 파일이 분석 기간 밖인 꼬리는 합칠 곳이 없어 세션 단위 지표에서만 빠진다 (토큰·메시지는 main으로 집계됨)
  const byRoot = new Map<string, SessionSummary>();
  for (const s of starters) if (s.rootUuid) byRoot.set(s.rootUuid, s);
  for (const s of main) {
    if (!s.isContinuation && !s.isForkChild) continue;
    const owner = s.rootUuid ? byRoot.get(s.rootUuid) : undefined;
    if (!owner) continue;
    owner.compacts += s.compacts;
    if (s.firstTs !== null && (owner.firstTs === null || s.firstTs < owner.firstTs)) owner.firstTs = s.firstTs;
    if (s.lastTs !== null && (owner.lastTs === null || s.lastTs > owner.lastTs)) owner.lastTs = s.lastTs;
  }
  for (const s of starters) {
    if (s.firstTs !== null && s.lastTs !== null) s.durationMin = Math.max(0, (s.lastTs - s.firstTs) / 60000);
  }

  // 토큰 합계 (서브에이전트 포함)
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, all: 0 };
  const modelAgg: Record<string, { tokens: number; input: number; output: number; cacheRead: number; cacheCreate: number }> = {};
  for (const s of all) {
    totals.input += s.usage.input;
    totals.output += s.usage.output;
    totals.cacheRead += s.usage.cacheRead;
    totals.cacheCreate5m += s.usage.cacheCreate5m;
    totals.cacheCreate1h += s.usage.cacheCreate1h;
    for (const [model, u] of Object.entries(s.perModel)) {
      const m = modelAgg[model] ?? (modelAgg[model] = { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
      m.input += u.input;
      m.output += u.output;
      m.cacheRead += u.cacheRead;
      m.cacheCreate += u.cacheCreate;
      m.tokens += u.input + u.output + u.cacheRead + u.cacheCreate;
    }
  }
  totals.all = totals.input + totals.output + totals.cacheRead + totals.cacheCreate5m + totals.cacheCreate1h;

  const cacheCreate = totals.cacheCreate5m + totals.cacheCreate1h;
  const promptDenom = totals.input + totals.cacheRead + cacheCreate;
  const cacheHitRate = promptDenom > 0 ? totals.cacheRead / promptDenom : 0;
  const recacheRate = totals.cacheRead + cacheCreate > 0 ? cacheCreate / (totals.cacheRead + cacheCreate) : 0;

  // 비용 추정 (참고치). 1h/5m 쓰기 배율은 모델별 분리가 안 되므로 전체 비율로 근사한다.
  const w1hShare = cacheCreate > 0 ? totals.cacheCreate1h / cacheCreate : 0;
  const writeMultiplier = 1.25 * (1 - w1hShare) + 2 * w1hShare;
  let estCostUSD = 0;
  let estSavedUSD = 0;
  for (const [model, m] of Object.entries(modelAgg)) {
    const { inUSD, outUSD } = priceOf(model);
    estCostUSD +=
      (m.input * inUSD + m.cacheRead * inUSD * 0.1 + m.cacheCreate * inUSD * writeMultiplier + m.output * outUSD) / 1e6;
    estSavedUSD += (m.cacheRead * inUSD * 0.9) / 1e6;
  }

  const totalTokens = Object.values(modelAgg).reduce((a, m) => a + m.tokens, 0);
  const modelMix = Object.entries(modelAgg)
    .map(([model, m]) => ({ model, tokens: m.tokens, pct: totalTokens > 0 ? Math.round((m.tokens / totalTokens) * 100) : 0 }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

  // 작업 분류 (+ 분야 안에 실제 어느 폴더 세션이 몇 개인지 드릴다운)
  const catCount = new Map<string, number>();
  const catPlaces = new Map<string, Map<string, number>>();
  for (const s of starters) {
    catCount.set(s.category, (catCount.get(s.category) ?? 0) + 1);
    const places = catPlaces.get(s.category) ?? new Map<string, number>();
    const place = placeLabel(s);
    places.set(place, (places.get(place) ?? 0) + 1);
    catPlaces.set(s.category, places);
  }
  const catEntries = [...catCount.entries()].sort((a, b) => b[1] - a[1]);
  let accPct = 0;
  const categories = catEntries.map(([name, n], i) => {
    const pct = i === catEntries.length - 1 ? Math.max(0, 100 - accPct) : Math.round((n / Math.max(1, starters.length)) * 100);
    accPct += pct;
    const projects = [...(catPlaces.get(name) ?? new Map()).entries()]
      .map(([p, c]) => ({ name: p, sessions: c as number }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 4);
    return { name, sessions: n, pct, projects };
  });

  // 프로젝트 '결'별 비중: 세션이 열린 폴더로 우테코 미션 / 개인 프로젝트 / 기타 분류 (+ 종류 안의 개별 프로젝트)
  const ptCount = new Map<string, number>();
  const ptPlaces = new Map<string, Map<string, number>>();
  for (const s of starters) {
    const k = projectKind(s);
    ptCount.set(k, (ptCount.get(k) ?? 0) + 1);
    const places = ptPlaces.get(k) ?? new Map<string, number>();
    const place = placeLabel(s);
    places.set(place, (places.get(place) ?? 0) + 1);
    ptPlaces.set(k, places);
  }
  const PT_ORDER = ['개인 프로젝트', '우테코 미션', '기타'];
  const projectTypes = [...ptCount.entries()]
    .map(([label, n]) => ({
      label,
      sessions: n,
      pct: Math.round((n / Math.max(1, starters.length)) * 100),
      projects: [...(ptPlaces.get(label) ?? new Map()).entries()]
        .map(([name, c]) => ({ name, sessions: c as number }))
        .sort((a, b) => b.sessions - a.sessions)
        .slice(0, 5),
    }))
    .sort((a, b) => PT_ORDER.indexOf(a.label) - PT_ORDER.indexOf(b.label) || b.sessions - a.sessions);

  // 활동 분포 (서브에이전트 포함): 메시지 단위로 분류된 토큰 귀속을 합산
  const actAgg = new Map<string, { msgs: number; output: number; total: number; details: Record<string, number> }>();
  for (const s of all) {
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
      // 상위 4개만 남긴다 (리포트·스냅샷 크기 관리)
      details: Object.fromEntries(
        Object.entries(t.details)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
      ),
    }))
    .sort((a, b) => b.total - a.total);

  // 일별 토큰: 빈 날도 0으로 채워 연속된 30칸을 만든다
  const dailyAgg = new Map<string, number>();
  for (const s of all) {
    for (const [day, t] of Object.entries(s.daily ?? {})) dailyAgg.set(day, (dailyAgg.get(day) ?? 0) + t);
  }
  const daily: { date: string; tokens: number }[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    daily.push({ date: key, tokens: dailyAgg.get(key) ?? 0 });
  }

  const toolAgg = new Map<string, number>();
  for (const s of all) {
    for (const [name, n] of Object.entries(s.toolCounts)) toolAgg.set(name, (toolAgg.get(name) ?? 0) + n);
  }
  const toolTop = [...toolAgg.entries()]
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 12);
  // 도구를 성격별로 묶은 비중 (전체 호출 기준). 정규식은 renderer의 TOOL_GROUPS와 동기화 유지
  const TOOL_GROUP_RES: { label: string; re: RegExp }[] = [
    { label: '읽기·탐색', re: /^(Read|Grep|Glob|LS|NotebookRead|WebFetch|WebSearch)$/ },
    { label: '파일 수정', re: /^(Edit|Write|NotebookEdit)$/ },
    { label: '터미널', re: /^Bash$/ },
    { label: '작업·대화', re: /^(Task\w*|TodoWrite|AskUserQuestion|Skill|Agent|ToolSearch|ExitPlanMode|EnterPlanMode)$/ },
    { label: 'MCP 연동', re: /^mcp__/ },
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

  // 행동 지표. 중단·질문은 꼬리 파일의 고유 라인도 대화의 일부라 main으로, 세션 단위 플래그는 starters로 센다
  const interruptions = main.reduce((a, s) => a + s.interruptions, 0);
  const subagentRuns = all.filter((s) => s.isSubagentFile).length + main.filter((s) => s.hasSidechain).length;
  const compactSessions = starters.filter((s) => s.compacts > 0).length;
  const longNoCompactSessions = starters.filter((s) => s.durationMin > 120 && s.compacts === 0).length;
  const withDuration = starters.filter((s) => s.durationMin > 0);
  const avgSessionMin = withDuration.length ? withDuration.reduce((a, s) => a + s.durationMin, 0) / withDuration.length : 0;
  // 첫 메시지 통계는 대화 시작 파일만 (이어하기·포크 꼬리의 "첫 메시지"는 대화 중간이다)
  const promptLens = starters
    .filter((s) => s.firstPrompt)
    .map((s) => s.firstPrompt.length)
    .sort((a, b) => a - b);
  const medianFirstPromptLen = promptLens.length ? promptLens[Math.floor(promptLens.length / 2)] : 0;
  // 사람이 친 전체 메시지 기준. 세션 첫 메시지만 보면 긴 세션 중간의 질문이 누락된다
  const humanMsgs = main.reduce((a, s) => a + s.humanMsgs, 0);
  const questionMsgs = main.reduce((a, s) => a + s.questionMsgs, 0);
  const questionRatio = humanMsgs > 0 ? questionMsgs / humanMsgs : 0;
  // 구체성 신호: 첫 메시지뿐 아니라 세션 중간 지시에도 맥락을 담는가 + 출발이 어긋나 끊는 빈도
  const directiveMsgs = main.reduce((a, s) => a + s.directiveMsgs, 0);
  const substantiveDirectives = main.reduce((a, s) => a + s.substantiveDirectives, 0);
  const substantiveDirectiveShare = directiveMsgs > 0 ? substantiveDirectives / directiveMsgs : 0;
  const escPer100 = humanMsgs > 0 ? (interruptions / humanMsgs) * 100 : 0;
  // 학습 주도성 신호: 파고들기(체인·이어받기)와 질문 성격을 100메시지당 비율로 정규화
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
  const cmdCount = new Map<string, number>();
  for (const s of main) for (const c of s.slashCommands) cmdCount.set(c, (cmdCount.get(c) ?? 0) + 1);
  const topCommands = [...cmdCount.entries()]
    .map(([cmd, n]) => ({ cmd, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);

  // 공신력 신호 보강 (Anthropic Claude Code Best Practices 기반). 기존 신호는 그대로 두고 추가만 한다
  // 구체성: 지시가 구체 파일·경로·@ 를 지목하는가 / 검증 실행을 함께 요청하는가
  const fileRefDirectives = main.reduce((a, s) => a + s.fileRefDirectives, 0);
  const verifyDirectives = main.reduce((a, s) => a + s.verifyDirectives, 0);
  const fileRefDirectiveShare = directiveMsgs > 0 ? fileRefDirectives / directiveMsgs : 0;
  const verifyDirectiveShare = directiveMsgs > 0 ? verifyDirectives / directiveMsgs : 0;
  // 컨텍스트 위생: /clear·/compact 커맨드 사용 / 한 세션 정정 폭주(3회+)
  const isClearCompact = (c: string) => /^\/?(clear|compact)$/i.test(c.trim());
  const clearCompactCommands = main.reduce((a, s) => a + s.slashCommands.filter(isClearCompact).length, 0);
  const correctionStormSessions = starters.filter((s) => s.interruptions > 2).length;
  // 도구 생태계: MCP 호출 / 외부 서비스 CLI / /init
  const mcpToolCalls = [...toolAgg.entries()].reduce((a, [name, n]) => a + (/^mcp__/.test(name) ? n : 0), 0);
  const CLI_TOOLS = new Set([
    'gh', 'aws', 'gcloud', 'sentry-cli', 'az', 'heroku', 'vercel', 'netlify',
    'supabase', 'stripe', 'doctl', 'kubectl', 'terraform', 'flyctl', 'wrangler',
  ]);
  const cmdDetails = actAgg.get('명령 실행')?.details ?? {};
  const cliToolUses = Object.entries(cmdDetails).reduce((a, [verb, n]) => a + (CLI_TOOLS.has(verb) ? n : 0), 0);
  const initCommands = main.reduce((a, s) => a + s.slashCommands.filter((c) => /^\/?init$/i.test(c.trim())).length, 0);
  const loopCommands = main.reduce((a, s) => a + s.slashCommands.filter((c) => /^\/?loop$/i.test(c.trim())).length, 0);
  // 비용: 저렴 모델(Haiku)로 싼 작업을 위임한 비중
  const haikuTokens = Object.entries(modelAgg).reduce((a, [m, v]) => a + (/haiku/i.test(m) ? v.tokens : 0), 0);
  const cheaperModelShare = totalTokens > 0 ? haikuTokens / totalTokens : 0;

  // 자주 쓰는 프로젝트 상위 3곳의 CLAUDE.md 유무
  const byProject = new Map<string, SessionSummary[]>();
  for (const s of starters) {
    const list = byProject.get(s.projectDir) ?? [];
    list.push(s);
    byProject.set(s.projectDir, list);
  }
  const claudeMd: Behavior['claudeMd'] = [...byProject.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .flatMap(([projectDir, list]) => {
      const cwd = list.find((s) => s.cwd)?.cwd;
      if (!cwd) return [];
      let has = false;
      try {
        has = fs.existsSync(path.join(cwd, 'CLAUDE.md'));
      } catch {
        has = false;
      }
      return [{ project: path.basename(cwd) || projectDir, cwd, has }];
    });

  const behavior: Behavior = {
    interruptions,
    subagentRuns,
    compactSessions,
    longNoCompactSessions,
    avgSessionMin,
    medianFirstPromptLen,
    humanMsgs,
    directiveMsgs,
    substantiveDirectiveShare,
    fileRefDirectiveShare,
    verifyDirectiveShare,
    escPer100,
    questionRatio,
    clearCompactCommands,
    correctionStormSessions,
    mcpToolCalls,
    cliToolUses,
    initCommands,
    loopCommands,
    cheaperModelShare,
    learningSignals,
    topCommands,
    claudeMd,
  };

  // 설정 자산 인벤토리: 스킬 호출은 Skill 도구 호출 + 슬래시 커맨드 양쪽에서 합산(근사)
  const topProjects = [...byProject.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 6)
    .flatMap(([projectDir, list]) => {
      const cwd = list.find((s) => s.cwd)?.cwd;
      return cwd ? [{ project: path.basename(cwd) || projectDir, cwd }] : [];
    });
  const skillUseCount = new Map<string, number>();
  for (const s of all) {
    for (const [k, v] of Object.entries(s.skillUses)) skillUseCount.set(k, (skillUseCount.get(k) ?? 0) + v);
  }
  for (const [cmd, n] of cmdCount) {
    const k = cmd.replace(/^\//, '');
    skillUseCount.set(k, (skillUseCount.get(k) ?? 0) + n);
  }
  const inventory = buildInventory(topProjects, skillUseCount);

  const reviewShare = actTotal > 0 ? (actAgg.get('코드 읽기·검수')?.total ?? 0) / actTotal : 0;
  // 학습 '양' 신호: 이해 중심 활동(대화·설계 + 코드 읽기·검수) 토큰 비중 + '학습·이해' 의도 세션 비중.
  // 질문의 '질'이 높아도 학습에 실제로 쓰는 비중이 낮으면 학습 점수를 누른다 (heuristics의 learnVolumeFactor)
  const understandShare =
    actTotal > 0
      ? ((actAgg.get('대화·설계')?.total ?? 0) + (actAgg.get('코드 읽기·검수')?.total ?? 0)) / actTotal
      : 0;
  const studyShare = starters.length > 0 ? (catCount.get('학습·이해') ?? 0) / starters.length : 0;

  // 공식 Claude Code 기능 커버리지: docs에서 추린 핵심 기능 중 기간 내 사용 여부를 로그·인벤토리로 탐지
  const toolUsed = (re: RegExp): boolean => [...toolAgg.keys()].some((k) => re.test(k));
  const featureCoverage: Report['featureCoverage'] = [
    { name: 'CLAUDE.md', used: inventory.globalClaudeMd.exists || inventory.projectClaudeMds.some((p) => p.has) },
    { name: '슬래시 커맨드', used: behavior.topCommands.length > 0 },
    { name: '서브에이전트', used: behavior.subagentRuns > 0 },
    { name: '스킬', used: inventory.skills.some((s) => s.uses > 0) },
    { name: '훅', used: inventory.hooks.length > 0 },
    { name: 'MCP', used: behavior.mcpToolCalls > 0 },
    { name: '플랜 모드', used: toolUsed(/^(ExitPlanMode|EnterPlanMode)$/) },
    { name: '할 일 추적', used: toolUsed(/^TodoWrite$/) },
    { name: '웹 검색·페치', used: toolUsed(/^(WebSearch|WebFetch)$/) },
    { name: '/init', used: behavior.initCommands > 0 },
    { name: '컨텍스트 관리', used: behavior.clearCompactCommands > 0 },
    { name: '외부 CLI', used: behavior.cliToolUses > 0 },
    { name: '반복 실행', used: behavior.loopCommands > 0 },
    { name: '커스텀 커맨드', used: (inventory.customCommands ?? 0) > 0 },
  ];

  const hin = { mainCount: starters.length, cacheHitRate, recacheRate, behavior, inventory, reviewShare, understandShare, studyShare, featureCoverage: featureCoverage ?? [] };
  const scores = buildScores(hin);
  const recommendations = buildRecommendations(hin);

  // opus 코칭용 샘플: 최신순, 프로젝트당 최대 3개, 총 12개
  const samples: Report['samples'] = [];
  const perProjectCount = new Map<string, number>();
  for (const s of starters) {
    if (samples.length >= 12) break;
    if (!s.firstPrompt || s.firstPrompt.length < 10) continue;
    const c = perProjectCount.get(s.projectDir) ?? 0;
    if (c >= 3) continue;
    perProjectCount.set(s.projectDir, c + 1);
    samples.push({
      project: s.cwd ? path.basename(s.cwd) : s.projectDir.split('-').slice(-2).join('-'),
      category: s.category,
      prompt: s.firstPrompt.slice(0, 200),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    days,
    files: fileCount,
    sessions: starters.length,
    skippedLines,
    totals,
    cacheHitRate,
    recacheRate,
    estCostUSD,
    estSavedUSD,
    modelMix,
    categories,
    projectTypes,
    activities,
    daily,
    toolTop,
    toolGroups,
    inventory,
    featureCoverage,
    behavior,
    scores,
    scoreCriteria: buildScoreCriteria(),
    recommendations,
    samples,
    env: { claudeBinary: findClaude(), projectsDirs: claudeProjectDirs() },
  };
}
