import * as fs from 'fs';
import * as path from 'path';
import { scanJsonl } from './scanner';
import { parseSession } from './parser';
import { buildRecommendations, buildScores, categorize } from './heuristics';
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
  const sessions: SessionSummary[] = [];
  let skippedLines = 0;
  let done = 0;
  for (const f of files) {
    onProgress?.({ phase: '세션 파일 분석 중', done, total: files.length });
    try {
      const { session, skippedLines: sk } = await parseSession(f);
      skippedLines += sk;
      sessions.push(session);
    } catch {
      // 깨진 파일은 건너뛴다
    }
    done++;
  }
  onProgress?.({ phase: '집계 중', done: files.length, total: files.length });
  return aggregate(days, files.length, sessions, skippedLines);
}

function aggregate(days: number, fileCount: number, all: SessionSummary[], skippedLines: number): Report {
  const main = all.filter((s) => !s.isSubagentFile);
  for (const s of main) s.category = categorize(s);

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

  // 작업 분류
  const catCount = new Map<string, number>();
  for (const s of main) catCount.set(s.category, (catCount.get(s.category) ?? 0) + 1);
  const catEntries = [...catCount.entries()].sort((a, b) => b[1] - a[1]);
  let accPct = 0;
  const categories = catEntries.map(([name, n], i) => {
    const pct = i === catEntries.length - 1 ? Math.max(0, 100 - accPct) : Math.round((n / Math.max(1, main.length)) * 100);
    accPct += pct;
    return { name, sessions: n, pct };
  });

  // 활동 분포 (서브에이전트 포함): 메시지 단위로 분류된 토큰 귀속을 합산
  const actAgg = new Map<string, { msgs: number; output: number; total: number }>();
  for (const s of all) {
    for (const [name, a] of Object.entries(s.activities)) {
      const t = actAgg.get(name) ?? { msgs: 0, output: 0, total: 0 };
      t.msgs += a.msgs;
      t.output += a.output;
      t.total += a.total;
      actAgg.set(name, t);
    }
  }
  const actTotal = [...actAgg.values()].reduce((a, t) => a + t.total, 0);
  const activities = [...actAgg.entries()]
    .map(([name, t]) => ({ name, ...t, pct: actTotal > 0 ? Math.round((t.total / actTotal) * 100) : 0 }))
    .sort((a, b) => b.total - a.total);

  const toolAgg = new Map<string, number>();
  for (const s of all) {
    for (const [name, n] of Object.entries(s.toolCounts)) toolAgg.set(name, (toolAgg.get(name) ?? 0) + n);
  }
  const toolTop = [...toolAgg.entries()]
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 12);

  // 행동 지표
  const interruptions = main.reduce((a, s) => a + s.interruptions, 0);
  const subagentRuns = all.filter((s) => s.isSubagentFile).length + main.filter((s) => s.hasSidechain).length;
  const compactSessions = main.filter((s) => s.compacts > 0).length;
  const longNoCompactSessions = main.filter((s) => s.durationMin > 120 && s.compacts === 0).length;
  const withDuration = main.filter((s) => s.durationMin > 0);
  const avgSessionMin = withDuration.length ? withDuration.reduce((a, s) => a + s.durationMin, 0) / withDuration.length : 0;
  const promptLens = main.filter((s) => s.firstPrompt).map((s) => s.firstPrompt.length).sort((a, b) => a - b);
  const medianFirstPromptLen = promptLens.length ? promptLens[Math.floor(promptLens.length / 2)] : 0;
  const withPrompt = main.filter((s) => s.firstPrompt);
  const questionRatio = withPrompt.length
    ? withPrompt.filter((s) => /[?？]|왜 |어떻게|뭐가|무엇|설명해|이유/.test(s.firstPrompt)).length / withPrompt.length
    : 0;
  const cmdCount = new Map<string, number>();
  for (const s of main) for (const c of s.slashCommands) cmdCount.set(c, (cmdCount.get(c) ?? 0) + 1);
  const topCommands = [...cmdCount.entries()]
    .map(([cmd, n]) => ({ cmd, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);

  // 자주 쓰는 프로젝트 상위 3곳의 CLAUDE.md 유무
  const byProject = new Map<string, SessionSummary[]>();
  for (const s of main) {
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
    questionRatio,
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
  const hin = { mainCount: main.length, cacheHitRate, recacheRate, behavior, inventory, reviewShare };
  const scores = buildScores(hin);
  const recommendations = buildRecommendations(hin);

  // opus 코칭용 샘플: 최신순, 프로젝트당 최대 3개, 총 12개
  const samples: Report['samples'] = [];
  const perProjectCount = new Map<string, number>();
  for (const s of main) {
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
    sessions: main.length,
    skippedLines,
    totals,
    cacheHitRate,
    recacheRate,
    estCostUSD,
    estSavedUSD,
    modelMix,
    categories,
    activities,
    toolTop,
    inventory,
    behavior,
    scores,
    recommendations,
    samples,
    env: { claudeBinary: findClaude(), projectsDirs: claudeProjectDirs() },
  };
}
