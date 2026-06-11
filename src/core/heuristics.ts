import * as os from 'os';
import * as path from 'path';
import { Behavior, Inventory, Rec, SessionSummary } from './types';

// 세션을 연 위치가 진짜 프로젝트 폴더인지, 홈·바탕화면처럼 폴더 없이 연 것인지 구분한다
type DirKind = 'project' | 'loose' | 'temp';

function dirKind(s: SessionSummary): DirKind {
  const cwd = s.cwd;
  if (cwd) {
    if (/\/(?:private\/)?(?:var\/folders|tmp)\//.test(cwd + '/')) return 'temp';
    const home = os.homedir();
    if (cwd === home) return 'loose';
    const rel = path.relative(home, cwd);
    if (['Desktop', 'Downloads', 'Documents'].includes(rel)) return 'loose';
    return 'project';
  }
  // cwd가 기록 안 된 드문 케이스: 폴더 이름 문자열로 근사
  const pd = s.projectDir;
  if (/^-?(private-)?(var-folders|tmp)/i.test(pd)) return 'temp';
  if (/-(Desktop|Downloads|Documents)$/i.test(pd)) return 'loose';
  return 'loose';
}

// 드릴다운에 보여줄 위치 라벨: 프로젝트면 폴더명, 아니면 한글 라벨
export function placeLabel(s: SessionSummary): string {
  const kind = dirKind(s);
  if (kind === 'temp') return '임시 폴더';
  if (s.cwd) {
    const home = os.homedir();
    if (s.cwd === home) return '홈 폴더';
    const rel = path.relative(home, s.cwd);
    if (rel === 'Desktop') return '바탕화면';
    if (rel === 'Downloads') return '다운로드';
    if (rel === 'Documents') return '문서 폴더';
    return path.basename(s.cwd);
  }
  const pd = s.projectDir;
  if (/-Desktop$/i.test(pd)) return '바탕화면';
  if (/-Downloads$/i.test(pd)) return '다운로드';
  if (/-Documents$/i.test(pd)) return '문서 폴더';
  return pd.split('-').filter(Boolean).slice(-2).join('-') || '알 수 없음';
}

export function categorize(s: SessionSummary): string {
  const dir = (s.projectDir + ' ' + (s.cwd ?? '')).toLowerCase();
  if (/(woowa|roomescape|mission)/.test(dir)) return '미션 개발';
  if (/(algorithm|algo-|study)/.test(dir)) return '학습';
  if (/(blog|github-io|retro|회고|리소스)/.test(dir)) return '글·회고';
  const p = s.firstPrompt;
  if (/(알고리즘|백준|문제 풀|공부)/.test(p)) return '학습';
  if (/(회고|블로그|글 써|README|독후)/.test(p)) return '글·회고';
  if (/(ppt|pptx|피피티|슬라이드|발표자료|가사|엑셀|xlsx|스프레드시트|pdf|docx|워드)/i.test(p)) return '문서 작업';
  // 위 어디에도 안 걸리면: 실제 프로젝트 폴더에서 연 세션은 사이드 프로젝트로 본다
  return dirKind(s) === 'project' ? '토이·앱 개발' : '기타';
}

export interface HeuristicInput {
  mainCount: number;
  cacheHitRate: number;
  recacheRate: number;
  behavior: Behavior;
  inventory: Inventory;
  reviewShare: number; // 전체 토큰 중 '코드 읽기·검수' 활동 비중
}

const clamp = (v: number): number => Math.max(5, Math.min(98, Math.round(v)));

export function buildScores(
  h: HeuristicInput
): { axis: string; score: number; desc: string; detail: string }[] {
  const b = h.behavior;
  const n = Math.max(1, h.mainCount);
  const pctOf = (v: number) => Math.round(v * 100);
  const claudeMdHave = b.claudeMd.length
    ? b.claudeMd.filter((c) => c.has).length / b.claudeMd.length
    : 0;

  const contextScore = clamp(
    80 -
      60 * (b.longNoCompactSessions / n) +
      15 * Math.min(1, (b.compactSessions / n) * 5) -
      (b.avgSessionMin > 120 ? 10 : 0)
  );
  // 프롬프트 구체성 = 의도를 한 번에 전달하는 습관. 첫 메시지 길이(셋업)뿐 아니라
  // 세션 중간 지시에 맥락이 담기는 비중(80자+ 지시)을 함께 본다. 포화점: 첫 메시지 180자, 본문 지시 28%.
  // Esc 중단은 출발이 어긋났다는 결과 신호라 감점. (정정 루프는 측정 결과 시도 크기에 비례해 신호로 안 씀 — 2026-06-11)
  const promptScore = clamp(
    20 +
      Math.min(30, b.medianFirstPromptLen / 6) +
      Math.min(35, b.substantiveDirectiveShare * 125) -
      Math.min(15, b.escPer100 * 1.8)
  );
  // 기능 활용도 = 만들어 둔 자산(CLAUDE.md·스킬·훅)과 위임 수단(서브에이전트·커맨드)을 실제로 쓰는가.
  // compact는 컨텍스트 운용 축에서만 본다 (이전엔 양쪽에 들어가 이중 계산이었음)
  const usedSkills = h.inventory.skills.filter((s) => s.uses > 0).length;
  const featureScore = clamp(
    10 +
      claudeMdHave * 25 +
      Math.min(15, b.topCommands.length * 5) +
      (b.subagentRuns > 0 ? 15 : 0) +
      (h.inventory.skills.length > 0 ? 8 : 0) +
      (usedSkills > 0 ? 12 : 0) +
      (h.inventory.hooks.length > 0 ? 15 : 0)
  );
  const costScore = clamp(h.cacheHitRate * 100 - Math.max(0, h.recacheRate - 0.35) * 60);
  // 학습 주도성 = 받은 답을 그대로 두지 않는 습관.
  // 파고들기(꼬리 체인 + 깊은 체인 + 이어받기) > 왜·원리 > 이해 확인 순 가중, 단순 질문율은 보조 신호.
  // 상한은 신호별 포화점: 한 신호가 비정상적으로 커도(긴 문서 붙여넣기 등) 점수를 독식하지 못하게 한다
  const lg = b.learningSignals;
  const learningScore = clamp(
    25 +
      Math.min(35, (lg.chainPer100 + lg.chain3Per100 + lg.grabPer100) * 3) +
      Math.min(20, lg.whyPer100 * 1.75) +
      Math.min(8, lg.confirmPer100 * 5) +
      Math.min(10, b.questionRatio * 20)
  );

  return [
    {
      axis: '프롬프트 구체성',
      score: promptScore,
      desc: '요청에 맥락·제약을 담아 의도를 한 번에 전달하는가',
      detail: `첫 메시지 중앙값 ${b.medianFirstPromptLen}자 · 80자 이상 지시 ${pctOf(b.substantiveDirectiveShare)}% · 중단 ${b.escPer100.toFixed(1)}회/100메시지`,
    },
    {
      axis: '학습 주도성',
      score: learningScore,
      desc: '받은 답을 그대로 두지 않고 꼬리질문으로 파고드는가',
      detail: `100메시지당 꼬리체인 ${lg.chainPer100.toFixed(1)} · 왜·원리 ${lg.whyPer100.toFixed(1)} · 질문 비율 ${pctOf(b.questionRatio)}%`,
    },
    {
      axis: '컨텍스트 운용',
      score: contextScore,
      desc: '대화가 커지기 전에 compact·clear로 끊어 토큰 낭비를 막는가',
      detail: `2시간+ 무압축 세션 ${b.longNoCompactSessions}개 · compact 쓴 세션 ${b.compactSessions}개 · 평균 ${Math.round(b.avgSessionMin)}분`,
    },
    {
      axis: '비용·캐시 효율',
      score: costScore,
      desc: '같은 컨텍스트를 다시 계산하지 않고 캐시에서 읽는 비율',
      detail: `캐시 적중 ${pctOf(h.cacheHitRate)}% · 캐시 재작성 ${pctOf(h.recacheRate)}%`,
    },
    {
      axis: '기능 활용도',
      score: featureScore,
      desc: 'CLAUDE.md·스킬·훅·서브에이전트 같은 도구를 실제로 쓰는가',
      detail: `CLAUDE.md ${b.claudeMd.filter((c) => c.has).length}/${b.claudeMd.length} · 커맨드 ${b.topCommands.length}종 · 스킬 ${usedSkills}/${h.inventory.skills.length} 사용 · 훅 ${h.inventory.hooks.length}개 · 서브에이전트 ${b.subagentRuns}회`,
    },
  ];
}

export function buildRecommendations(h: HeuristicInput): Rec[] {
  const b = h.behavior;
  const n = Math.max(1, h.mainCount);
  const out: Rec[] = [];

  if (b.longNoCompactSessions >= 3) {
    out.push({
      id: 'long-session',
      severity: 'high',
      title: '긴 세션을 작업 단위로 끊기',
      now: `2시간 넘게 /compact 없이 이어간 세션이 ${b.longNoCompactSessions}개예요. 커진 컨텍스트를 매 턴 끌고 다니면 토큰 낭비가 커요.`,
      better: '기능 하나가 끝나면 /compact, 주제가 완전히 바뀌면 /clear로 끊어주세요.',
      script: 'CLAUDE.md에 추가: "한 작업 단위가 끝나면 /compact 또는 /clear를 한 줄로 안내해줘"',
    });
  }
  const missing = b.claudeMd.filter((c) => !c.has);
  if (missing.length > 0) {
    out.push({
      id: 'claude-md',
      severity: 'high',
      title: 'CLAUDE.md부터 만들기',
      now: `자주 쓰는 프로젝트 중 ${missing.map((m) => m.project).join(', ')}에 CLAUDE.md가 없어요. 매 세션 같은 설명을 반복하게 돼요.`,
      better: '프로젝트 규칙(빌드 명령, 컨벤션, 하지 말 것)을 CLAUDE.md에 한 번만 적어두세요.',
      script: '해당 프로젝트 폴더에서 claude 실행 후 입력: /init',
    });
  }
  if (b.subagentRuns === 0) {
    out.push({
      id: 'subagent',
      severity: 'mid',
      title: '큰 탐색은 서브에이전트로',
      now: '최근 30일간 서브에이전트 사용이 없어요. 넓은 코드 탐색까지 메인 대화에서 하면 컨텍스트가 빨리 차요.',
      better: '여러 파일을 훑는 탐색·조사는 서브에이전트에게 맡기고 결론만 받아보세요.',
      script: '"Explore 서브에이전트로 이 레포 인증 구조 훑고 요약만 알려줘"',
    });
  }
  if (b.escPer100 > 4) {
    out.push({
      id: 'interrupt',
      severity: 'mid',
      title: '중단 후 재지시 줄이기',
      now: `메시지 100개당 ${b.escPer100.toFixed(1)}회꼴로 응답을 끊고 다시 지시했어요(총 ${b.interruptions}회). 요청에 제약이 빠졌다는 신호예요.`,
      better: '처음 요청에 범위, 건드리지 말 것, 완료 기준을 같이 적어주세요.',
      script: '"<할 일>. 단 <건드리지 말 것>은 유지. 완료 기준: <기준>" 형태로 요청',
    });
  }
  if (b.directiveMsgs >= 30 && b.substantiveDirectiveShare < 0.15) {
    out.push({
      id: 'vague-directives',
      severity: 'mid',
      title: '세션 중간 지시에도 맥락 담기',
      now: `작업 지시 ${b.directiveMsgs}개 중 80자를 넘는 건 ${Math.round(b.substantiveDirectiveShare * 100)}%뿐이에요. 첫 메시지 이후엔 대부분 한 줄 지시로 맡기고 있어요.`,
      better: '이어지는 지시에도 대상 파일·범위·완료 기준을 한 줄씩 담아주세요. 모호한 지시는 어긋난 결과와 재작업으로 돌아와요.',
      script: '"<할 일>. 대상: <파일/범위>. 완료 기준: <기준>" 형태로 후속 지시',
    });
  }
  if (h.recacheRate > 0.5) {
    out.push({
      id: 'recache',
      severity: 'mid',
      title: '캐시 재작성 비율 높음',
      now: '캐시를 읽기보다 새로 쓰는 비율이 높아요. 작업 사이 간격이 길어 캐시가 자주 만료되는 패턴이에요.',
      better: '이어서 할 작업은 한 세션에서 몰아서, 멈출 거면 깔끔하게 끝내고 새로 시작하세요.',
      script: '자리 비우기 전: "여기까지 정리하고 다음 할 일 목록만 남겨줘" 후 /compact',
    });
  }
  if (b.learningSignals.chainPer100 + b.learningSignals.grabPer100 < 2 && b.questionRatio < 0.25) {
    out.push({
      id: 'learning',
      severity: 'mid',
      title: '받은 답에 꼬리질문 달기',
      now: '답을 받은 뒤 되묻는 꼬리질문이 거의 없어요. 받아쓰기 위주로 쓰고 있다는 신호예요.',
      better: '답이 오면 "왜 이 방식인지", "그럼 ~한 경우는 어떻게 되는지"를 한 번 더 파보세요.',
      script: '"정답 코드 말고, 내 코드의 문제 2가지를 질문 형태로 던져줘"',
    });
  }
  if (b.topCommands.length < 2) {
    out.push({
      id: 'commands',
      severity: 'mid',
      title: '슬래시 커맨드 활용',
      now: '슬래시 커맨드 사용이 거의 없어요.',
      better: '/compact, /clear, /init 세 개부터 습관으로 만들어보세요.',
      script: '세션 중 입력: /compact (대화 요약 후 압축), /clear (새로 시작)',
    });
  }
  const unusedSkills = h.inventory.skills.filter((s) => s.uses === 0);
  if (unusedSkills.length >= 3) {
    out.push({
      id: 'unused-skills',
      severity: 'mid',
      title: '잠자는 스킬 정리',
      now: `만들어둔 스킬 ${h.inventory.skills.length}개 중 ${unusedSkills.length}개(${unusedSkills
        .slice(0, 3)
        .map((s) => s.name)
        .join(', ')} 등)는 최근 호출 기록이 없어요.`,
      better: '안 쓰는 스킬은 지우고, 계속 쓸 스킬은 description의 트리거 문구를 실제 말버릇에 맞게 다듬어주세요.',
      script: '"~/.claude/skills에서 최근 한 달간 안 쓴 스킬을 찾아서 정리 후보를 알려줘"',
    });
  }
  if (h.inventory.hooks.length === 0) {
    out.push({
      id: 'no-hooks',
      severity: 'mid',
      title: '반복 확인은 훅으로',
      now: '설정된 훅이 없어요. 매번 손으로 확인하는 규칙(린트, 알림)이 있다면 자동화할 수 있어요.',
      better: 'PostToolUse 훅으로 파일 저장 직후 검사를, Stop 훅으로 응답 종료 알림을 걸어보세요.',
      script: '"내 settings.json에 Write|Edit 후 lint를 돌리는 PostToolUse 훅을 추가해줘"',
    });
  }
  if (h.reviewShare < 0.03 && h.mainCount >= 20) {
    out.push({
      id: 'review',
      severity: 'mid',
      title: '받은 코드 검수 늘리기',
      now: '코드를 읽고 검토하는 활동 비중이 3% 미만이에요. 생성 위주로만 쓰고 있다는 신호예요.',
      better: '머지 전에 변경분 리뷰를 시키고, 직접 diff를 따라 읽는 시간을 의식적으로 넣어보세요.',
      script: '커밋 직전 입력: /code-review (변경분 버그·정리 포인트 리뷰)',
    });
  }

  if (out.length === 0) {
    out.push({
      id: 'good',
      severity: 'mid',
      title: '기본기는 탄탄해요',
      now: '큰 낭비 패턴이 안 보여요.',
      better: 'opus 코칭으로 프롬프트 단위 피드백을 받아보세요.',
      script: '"내 최근 요청 방식에서 고칠 점 3가지만 알려줘"',
    });
  }
  return out.slice(0, 3);
}
