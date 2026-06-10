import { Behavior, Inventory, Rec, SessionSummary } from './types';

export function categorize(s: SessionSummary): string {
  const dir = (s.projectDir + ' ' + (s.cwd ?? '')).toLowerCase();
  if (/(woowa|roomescape|mission)/.test(dir)) return '미션 개발';
  if (/(algorithm|algo-|study)/.test(dir)) return '학습';
  if (/(blog|github-io|retro|회고|리소스)/.test(dir)) return '글·회고';
  const p = s.firstPrompt;
  if (/(알고리즘|백준|문제 풀|공부)/.test(p)) return '학습';
  if (/(회고|블로그|글 써|README|독후)/.test(p)) return '글·회고';
  return '기타·토이';
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

export function buildScores(h: HeuristicInput): { axis: string; score: number }[] {
  const b = h.behavior;
  const n = Math.max(1, h.mainCount);
  const claudeMdHave = b.claudeMd.length
    ? b.claudeMd.filter((c) => c.has).length / b.claudeMd.length
    : 0;

  const contextScore = clamp(
    80 -
      60 * (b.longNoCompactSessions / n) +
      15 * Math.min(1, (b.compactSessions / n) * 5) -
      (b.avgSessionMin > 120 ? 10 : 0)
  );
  const promptScore = clamp(
    25 + Math.min(55, b.medianFirstPromptLen / 4) - Math.min(20, (b.interruptions / n) * 25)
  );
  const featureScore = clamp(
    15 +
      (b.subagentRuns > 0 ? 18 : 0) +
      (b.compactSessions > 0 ? 15 : 0) +
      Math.min(20, b.topCommands.length * 5) +
      claudeMdHave * 25
  );
  const costScore = clamp(h.cacheHitRate * 100 - Math.max(0, h.recacheRate - 0.35) * 60);
  const learningScore = clamp(25 + b.questionRatio * 70);

  return [
    { axis: '프롬프트 구체성', score: promptScore },
    { axis: '학습 주도성', score: learningScore },
    { axis: '컨텍스트 운용', score: contextScore },
    { axis: '비용·캐시 효율', score: costScore },
    { axis: '기능 활용도', score: featureScore },
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
  if (b.interruptions / n > 0.3) {
    out.push({
      id: 'interrupt',
      severity: 'mid',
      title: '중단 후 재지시 줄이기',
      now: `응답을 끊고 다시 지시한 횟수가 ${b.interruptions}회예요. 첫 요청에 제약이 빠졌다는 신호예요.`,
      better: '처음 요청에 범위, 건드리지 말 것, 완료 기준을 같이 적어주세요.',
      script: '"<할 일>. 단 <건드리지 말 것>은 유지. 완료 기준: <기준>" 형태로 요청',
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
  if (b.questionRatio < 0.2) {
    out.push({
      id: 'learning',
      severity: 'mid',
      title: '받아쓰기보다 질문',
      now: '요청 대부분이 "~해줘" 형태예요. 교육 기간에는 정답을 받는 것보다 이유를 묻는 게 남아요.',
      better: '코드를 받기 전에 "왜 이 방식인지", "다른 선택지는 뭔지"를 먼저 물어보세요.',
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
