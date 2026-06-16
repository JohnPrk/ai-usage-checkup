import * as fs from 'fs';
import * as path from 'path';
import { scanJsonl, ScannedFile } from './scanner';
import { parseSession } from './parser';
import { buildRecommendations, buildScoreCriteria, buildScores, categorize, placeLabel, projectKind } from './heuristics';
import { buildInventory } from './inventory';
import { findClaude } from './llm';
import { claudeProjectDirs } from './paths';
import { BaseAnalyzer } from './provider';
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

// 분석(요청) 시점의 로컬 날짜·시각. toISOString()은 UTC라 자정 직후 몇 시간은
// 전날 날짜로 찍혀 분석일·스냅샷 파일명이 다음 날로 안 넘어간다
function localStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// Claude Code 사용 로그(~/.claude/projects/**.jsonl) 분석기.
export class ClaudeAnalyzer extends BaseAnalyzer<ScannedFile, SessionSummary> {
  readonly id = 'claude' as const;
  readonly label = 'Claude Code';

  protected scan(days: number): ScannedFile[] {
    return scanJsonl(days);
  }

  protected async parseAll(
    files: ScannedFile[],
    onProgress?: (p: Progress) => void
  ): Promise<{ sessions: SessionSummary[]; skippedLines: number }> {
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
    return { sessions, skippedLines };
  }

  protected aggregate(days: number, fileCount: number, sessions: SessionSummary[], skippedLines: number): Report {
    return aggregate(days, fileCount, sessions, skippedLines);
  }
}

// 기존 호출부 호환 래퍼 (main.ts·cli). 내부적으로 ClaudeAnalyzer.run 을 쓴다.
export function runAnalysis(days: number, onProgress?: (p: Progress) => void): Promise<Report> {
  return new ClaudeAnalyzer().run(days, onProgress);
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
        .slice(0, 8),
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
  // 서브에이전트는 '직접 호출'(Agent/Task 도구)만 인정한다. 자동 생성 사이드체인·서브에이전트 파일은
  // 사용자가 의도해 위임한 게 아니므로 기능 활용도·추천에서 뺀다 (2026-06-14 냉정 재보정).
  const subagentRuns = [...toolAgg.entries()].reduce((a, [name, n]) => a + (/^(Agent|Task)$/.test(name) ? n : 0), 0);
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
  // 오류 회복·수렴 축(공용): 도구 실패(is_error)가 난 세션 중 끝까지 해결(이후 성공으로 닫힘)된 비율.
  // 세션 단위는 파일 단위로 근사 — 이어하기·포크 꼬리의 도구결과도 자기 파일에 집계되고, 점수는 비율이라 robust.
  const failSessionList = main.filter((s) => s.toolFailures > 0);
  const failureSessions = failSessionList.length;
  const unresolvedFailSessions = failSessionList.filter((s) => s.toolFailures - s.toolFailuresResolved > 0).length;
  // 균등가중 미해결 비율: 세션별 (미해결/실패)의 평균 — 큰 세션이 좌우 못 하게. 실패 1개를 통째로 버린 세션을 세게(=1) 잡는다.
  const meanUnresolvedShare = failureSessions > 0
    ? failSessionList.reduce((a, s) => a + (s.toolFailures - s.toolFailuresResolved) / s.toolFailures, 0) / failureSessions
    : 0;
  const failureEvents = main.reduce((a, s) => a + s.toolFailures, 0);
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
  // 공식 기능 활용 신호: 대화 내용이라 main 기준으로 합산(포크 사본 중복 방지)
  const thinkEscalations = main.reduce((a, s) => a + s.thinkEscalations, 0);
  const imageInputs = main.reduce((a, s) => a + s.imageInputs, 0);
  const backgroundRuns = main.reduce((a, s) => a + s.backgroundRuns, 0);
  const atMentions = main.reduce((a, s) => a + s.atMentions, 0);
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
    failureSessions,
    unresolvedFailSessions,
    meanUnresolvedShare,
    failureEvents,
    escPer100,
    questionRatio,
    clearCompactCommands,
    correctionStormSessions,
    mcpToolCalls,
    cliToolUses,
    initCommands,
    loopCommands,
    thinkEscalations,
    imageInputs,
    backgroundRuns,
    atMentions,
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

  // 공식 Claude Code 기능 커버리지 + 채택 단계. docs에서 추린 핵심 기능별로 '사용 횟수'를 세어 채택도(adopt)를 매긴다.
  // weight = 활용 '난이도'(자동 내장도구 0.4 / 직접 셋업 1.0). adopt = '얼마나 자주 쓰나'(자주 10+ =1.0, 가끔 5~9 =0.7, 맛보기 1~4 =0.4).
  // 한두 번 써본 기능은 부분만 인정한다 — '다양하게 + 잘 쓰고 있나'를 재는 축이라 1회=활용으로 치지 않는다 (2026-06-14).
  const toolCount = (re: RegExp): number => [...toolAgg.entries()].reduce((a, [k, n]) => a + (re.test(k) ? n : 0), 0);
  const skillUsesList = inventory.skills.map((s) => s.uses);
  const skillUseTotal = skillUsesList.reduce((a, n) => a + n, 0);
  const skillConcentration = skillUseTotal > 0 ? Math.max(...skillUsesList) / skillUseTotal : 0;
  // '슬래시 커맨드' 커버리지는 별도 기능으로 따로 점수화되는 커맨드(/clear·/compact·/init·/loop)를 빼고
  // 순수 일반 커맨드만 센다 — 한 입력이 두 기능 커버리지에 중복 기여하지 않도록 (2026-06-15)
  const isOwnFeatureCmd = (c: string) => isClearCompact(c) || /^\/?(init|loop)$/i.test(c.trim());
  const slashTotal = [...cmdCount.entries()].reduce((a, [c, n]) => a + (isOwnFeatureCmd(c) ? 0 : n), 0);
  const hasClaudeMd = inventory.globalClaudeMd.exists || inventory.projectClaudeMds.some((p) => p.has);
  // 사용 횟수 → 채택 단계 (자주/가끔/맛보기/미사용)
  // 채택 단계는 그룹 헤더(자주/가끔·맛보기/안 씀)로 보여주므로 detail엔 '횟수'만 담는다(중복 제거).
  const graded = (count: number): { used: boolean; adopt: number; detail: string } => {
    if (count <= 0) return { used: false, adopt: 0, detail: '' };
    if (count >= 10) return { used: true, adopt: 1, detail: `${count.toLocaleString()}회` };
    if (count >= 5) return { used: true, adopt: 0.7, detail: `${count}회` };
    return { used: true, adopt: 0.4, detail: `${count}회` };
  };
  // 설정형(횟수가 의미 없음 — 있으면 채택): CLAUDE.md·훅·/init·커스텀 커맨드
  const config = (count: number, unit: '보유' | '개' | '실행'): { used: boolean; adopt: number; detail: string } =>
    count > 0
      ? { used: true, adopt: 1, detail: unit === '개' ? `${count}개` : unit === '실행' ? '실행함' : '보유' }
      : { used: false, adopt: 0, detail: '' };
  const feat = (name: string, g: { used: boolean; adopt: number; detail: string }, weight: number) => ({
    name,
    used: g.used,
    weight,
    adopt: g.adopt,
    detail: g.detail,
  });
  // Claude가 자동으로 부르는 보조도구(MCP 스크린샷·todo·webfetch 등)는 '· 자동' 표시 — 직접 활용과 구분(가중치도 0.4로 낮춤).
  const autoTag = (g: { used: boolean; adopt: number; detail: string }) => (g.used ? { ...g, detail: `${g.detail} · 자동` } : g);
  const featureCoverage: Report['featureCoverage'] = [
    feat('CLAUDE.md', config(hasClaudeMd ? 1 : 0, '보유'), 1),
    feat('슬래시 커맨드', graded(slashTotal), 0.4),
    feat('서브에이전트', graded(behavior.subagentRuns), 1),
    feat('스킬', graded(skillUseTotal), 1),
    feat('훅', config(inventory.hooks.length, '개'), 1),
    feat('MCP', autoTag(graded(behavior.mcpToolCalls)), 0.4),
    feat('플랜 모드', graded(toolCount(/^(ExitPlanMode|EnterPlanMode)$/)), 1),
    feat('할 일 추적', autoTag(graded(toolCount(/^TodoWrite$/))), 0.4),
    feat('웹 검색·페치', autoTag(graded(toolCount(/^(WebSearch|WebFetch)$/))), 0.4),
    feat('/init', config(behavior.initCommands, '실행'), 1),
    feat('컨텍스트 관리', graded(behavior.clearCompactCommands), 0.4),
    feat('외부 CLI', graded(behavior.cliToolUses), 1),
    feat('반복 실행', graded(behavior.loopCommands), 1),
    feat('커스텀 커맨드', config(inventory.customCommands ?? 0, '개'), 1),
    feat('확장 사고', graded(behavior.thinkEscalations), 1),
    feat('이미지 입력', graded(behavior.imageInputs), 1),
    feat('백그라운드 실행', graded(behavior.backgroundRuns), 1),
    feat('@ 파일 멘션', graded(behavior.atMentions), 1),
  ];
  // 기능 활용도 보조 신호: 탐색 부하(서브에이전트가 필요한 상황인지)
  const exploreGroup = toolGroups.find((g) => g.label === '읽기·탐색');
  const exploreShare = exploreGroup ? exploreGroup.pct / 100 : 0;

  const hin = { mainCount: starters.length, cacheHitRate, recacheRate, behavior, inventory, reviewShare, understandShare, studyShare, featureCoverage: featureCoverage ?? [], skillConcentration, skillUseTotal, exploreShare };
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
    generatedAt: localStamp(),
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
