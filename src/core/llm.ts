import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Coaching, Report } from './types';

export function findClaude(): string | null {
  const names = process.platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude'];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  // GUI 앱으로 실행되면 셸 PATH를 못 받으므로 흔한 설치 경로를 직접 확인한다
  dirs.push(
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.claude', 'local')
  );
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

export async function runCoaching(report: Report, model = 'opus'): Promise<Coaching> {
  const bin = findClaude();
  if (!bin) {
    return {
      status: 'no_binary',
      message: 'claude CLI를 찾지 못했어요. 터미널에서 claude가 실행되는지 확인해주세요.',
    };
  }

  const prompt = buildPrompt(report);
  const env: NodeJS.ProcessEnv = { ...process.env };
  // 다른 Claude 세션/프록시 환경에서 실행돼도 사용자 기본 인증으로 직접 호출되도록 정리
  for (const k of [
    'ANTHROPIC_BASE_URL',
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_AGENT_SDK_VERSION',
    'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
    'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
    'CLAUDE_EFFORT',
    'BAGGAGE',
    'AI_AGENT',
  ]) {
    delete env[k];
  }

  const args = ['-p', prompt, '--model', model, '--output-format', 'json', '--no-session-persistence'];
  const res = await run(bin, args, env, 180_000);

  if (res.timedOut) return { status: 'error', message: '코칭 호출이 시간 초과됐어요(180초).' };

  let envelope: any = null;
  try {
    envelope = JSON.parse(res.stdout.trim());
  } catch {
    // fall through
  }
  if (!envelope) {
    const t = (res.stdout + '\n' + res.stderr).trim().slice(0, 300);
    if (/not logged in|\/login/i.test(t)) {
      return { status: 'not_logged_in', message: '터미널에서 claude를 실행해 /login 해주세요.' };
    }
    return { status: 'error', message: 'claude 응답을 해석하지 못했어요: ' + t };
  }

  const resultText = String(envelope.result ?? '');
  if (envelope.is_error) {
    if (/not logged in/i.test(resultText)) {
      return { status: 'not_logged_in', message: '터미널에서 claude를 실행해 /login 해주세요.' };
    }
    return { status: 'error', message: resultText.slice(0, 300) || '알 수 없는 오류' };
  }

  try {
    const data = extractJson(resultText);
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const recommendations = Array.isArray(data.recommendations)
      ? data.recommendations.slice(0, 3).map((r: any) => ({
          title: str(r.title),
          now: str(r.now),
          better: str(r.better),
          script: str(r.script),
        }))
      : [];
    const promptRewrites = Array.isArray(data.promptRewrites)
      ? data.promptRewrites.slice(0, 3).map((r: any) => ({
          original: str(r.original),
          score: typeof r.score === 'number' ? Math.round(r.score) : 0,
          better: str(r.better),
        }))
      : [];
    return { status: 'ok', summary: str(data.summary), recommendations, promptRewrites };
  } catch {
    return { status: 'error', message: '코칭 결과 JSON 해석 실패: ' + resultText.slice(0, 200) };
  }
}

function extractJson(text: string): any {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  return JSON.parse(t);
}

function buildPrompt(r: Report): string {
  const round2 = (v: number) => Math.round(v * 100) / 100;
  const stats = {
    기간일: r.days,
    세션수: r.sessions,
    토큰합계: r.totals,
    캐시적중률: round2(r.cacheHitRate),
    재캐싱비율: round2(r.recacheRate),
    모델별: r.modelMix,
    작업분류: r.categories,
    활동분포: r.activities.map((a) => ({ 활동: a.name, 토큰비중pct: a.pct, 메시지수: a.msgs })),
    도구상위: r.toolTop.slice(0, 8),
    스킬호출: r.inventory.skills.map((s) => ({ 이름: s.name, 호출: s.uses })),
    훅구성: r.inventory.hooks.map((hk) => `${hk.event}:${hk.command}`),
    행동: {
      중단횟수: r.behavior.interruptions,
      // 구버전 스냅샷에는 없을 수 있는 필드들
      중단per100msg: r.behavior.escPer100 != null ? round2(r.behavior.escPer100) : undefined,
      지시형메시지수: r.behavior.directiveMsgs,
      본문있는지시비중: r.behavior.substantiveDirectiveShare != null ? round2(r.behavior.substantiveDirectiveShare) : undefined,
      서브에이전트실행: r.behavior.subagentRuns,
      compact사용세션: r.behavior.compactSessions,
      compact없는긴세션: r.behavior.longNoCompactSessions,
      평균세션분: Math.round(r.behavior.avgSessionMin),
      질문메시지비율: round2(r.behavior.questionRatio),
      // 구버전 스냅샷에는 learningSignals가 없을 수 있다
      학습신호per100msg: r.behavior.learningSignals
        ? {
            꼬리체인: round2(r.behavior.learningSignals.chainPer100),
            깊은체인: round2(r.behavior.learningSignals.chain3Per100),
            이어받기: round2(r.behavior.learningSignals.grabPer100),
            왜원리: round2(r.behavior.learningSignals.whyPer100),
            이해확인: round2(r.behavior.learningSignals.confirmPer100),
          }
        : undefined,
      자주쓴커맨드: r.behavior.topCommands,
      CLAUDEmd: r.behavior.claudeMd.map((c) => ({ project: c.project, has: c.has })),
    },
    휴리스틱점수: r.scores,
  };
  const samples = r.samples
    .map((s, i) => `${i + 1}. [${s.category}/${s.project}] ${s.prompt.replace(/\s+/g, ' ')}`)
    .join('\n');

  return `너는 Claude Code 사용 코치다. 대상은 1~3년차 백엔드 개발자(우아한테크코스 교육생)다.
아래 [통계]와 [세션 첫 메시지 샘플]을 보고 이 사람의 AI 사용 습관을 코칭해라.

반드시 아래 스키마의 JSON 한 개만 출력한다. 마크다운, 설명, 코드펜스 금지.
{"summary":"전체 진단 두 문장","recommendations":[{"title":"제목","now":"지금 패턴 한 문장","better":"바꿀 방향 한 문장","script":"복사해서 바로 쓸 프롬프트 또는 CLAUDE.md 한 줄"}],"promptRewrites":[{"original":"샘플 원문 일부","score":1,"better":"개선한 프롬프트"}]}

규칙:
- recommendations는 정확히 3개. 통계에 근거 없는 추측 금지.
- promptRewrites는 샘플 중 가장 모호한 3개를 골라 다시 써라. score는 1~10.
- 말투는 동료 멘토처럼. 존댓말. 짧고 구체적으로.

[통계]
${JSON.stringify(stats)}

[세션 첫 메시지 샘플]
${samples}`;
}

function run(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      env,
      cwd: os.tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || String(e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
