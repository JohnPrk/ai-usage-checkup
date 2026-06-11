import * as fs from 'fs';
import * as path from 'path';
import { scanJsonl } from './scanner';
import { parseSession } from './parser';
import { buildRecommendations, buildScores, categorize, placeLabel } from './heuristics';
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
    escPer100,
    questionRatio,
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
  const hin = { mainCount: starters.length, cacheHitRate, recacheRate, behavior, inventory, reviewShare };
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
    activities,
    daily,
    toolTop,
    inventory,
    behavior,
    scores,
    recommendations,
    samples,
    env: { claudeBinary: findClaude(), projectsDirs: claudeProjectDirs() },
  };
}
