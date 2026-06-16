import * as os from 'os';
import * as path from 'path';
import { AxisCriterion, Behavior, Inventory, Rec, ScoreMetric, SessionSummary } from './types';
import {
  featureScore,
  learningScore,
  promptScore,
  recoverScore,
  promptCriterion,
  learningCriterion,
  recoverCriterion,
  featureCriterion,
} from './scoring/core-axes';

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

// 세션이 열린 폴더로 작업의 '결'을 가른다: 우테코 미션 / 개인 프로젝트 / 기타(특정 프로젝트가 아닌 느슨한 세션).
// placeLabel과 달리 cwd 전체 경로를 봐서 woowa_course 하위 미션까지 잡는다.
export function projectKind(s: SessionSummary): string {
  const cwd = s.cwd;
  if (cwd) {
    const home = os.homedir();
    if (cwd === home || cwd === path.join(home, 'Desktop')) return '기타';
    if (/\/woowa_course\//.test(cwd) || /roomescape|racingcar/i.test(path.basename(cwd))) return '우테코 미션';
    return '개인 프로젝트';
  }
  const pd = s.projectDir;
  if (/woowa_course|roomescape|racingcar/i.test(pd)) return '우테코 미션';
  if (/-Desktop$/i.test(pd) || /^-Users-[^-]+$/.test(pd)) return '기타';
  return '개인 프로젝트';
}

// 작업 의도 카테고리. 세션 전체 대화 내용(intentHits)에 학습·활동 신호를 더해 판정한다.
// 디렉토리·첫 문장은 분류에 안 쓴다 (드릴다운에서 위치만 설명용으로 보여줄 뿐).
const INTENT_LABELS = ['기능 개발', '버그 수정', '학습·이해', '리팩토링', '글쓰기', '환경 설정'];

export function categorize(s: SessionSummary): string {
  const k: Record<string, number> = {};
  for (const label of INTENT_LABELS) k[label] = s.intentHits[label] ?? 0;
  const amsg = (n: string): number => s.activities[n]?.msgs ?? 0;
  const editMsgs = amsg('서버·스크립트 코드') + amsg('프론트 코드') + amsg('문서·설정 파일');
  const readMsgs = amsg('코드 읽기·검수');
  const qRatio = s.humanMsgs > 0 ? s.questionMsgs / s.humanMsgs : 0;

  // '하는' 의도: 키워드 + (기능은 편집 활동으로 보강). 버그·리팩토링·글쓰기 키워드는 변별력이 커서 가중.
  const doing: Record<string, number> = {
    '기능 개발': k['기능 개발'] + Math.min(4, editMsgs * 0.4),
    '버그 수정': k['버그 수정'] * 1.6,
    '리팩토링': k['리팩토링'] * 1.5,
    '환경 설정': k['환경 설정'] + Math.min(2, amsg('문서·설정 파일') * 0.3),
    '글쓰기': k['글쓰기'] * 1.5,
  };
  let bestDoing = '기능 개발';
  let bestDoingVal = -1;
  for (const label of Object.keys(doing)) {
    if (doing[label] > bestDoingVal) {
      bestDoingVal = doing[label];
      bestDoing = label;
    }
  }
  // '학습·이해'는 이해 중심 세션에만: 학습 키워드 + 읽기 위주 활동 + 아주 높은 질문 비중만 약하게.
  // (질문 많은 사람도 편집하며 묻는 건 '하는' 세션이다 — 학습이 doing을 확실히 압도할 때만 학습으로)
  const learn = k['학습·이해'] + Math.min(3, readMsgs * 0.4) + (qRatio >= 0.6 ? 1.5 : 0);

  if (editMsgs >= 2) {
    // 코드를 고친 세션은 기본적으로 '하는' 세션
    if (learn >= bestDoingVal * 1.6 && learn >= 4) return '학습·이해';
    if (bestDoingVal >= 0.6) return bestDoing;
    return '기능 개발';
  }
  // 편집이 거의 없는 세션: 이해·대화 위주
  if (learn >= 1.5) return '학습·이해';
  if (bestDoingVal >= 1) return bestDoing;
  return '기타';
}

export interface HeuristicInput {
  mainCount: number;
  cacheHitRate: number;
  recacheRate: number;
  behavior: Behavior;
  inventory: Inventory;
  reviewShare: number; // 전체 토큰 중 '코드 읽기·검수' 활동 비중
  // 오류 회복·수렴 축 입력은 behavior(failureSessions 등)에서 직접 읽는다 — 별도 필드 없음
  understandShare: number; // 이해 중심 활동(대화·설계 + 코드 읽기·검수) 토큰 비중 — 학습 '양'의 축
  studyShare: number; // '학습·이해' 의도 세션 비중
  featureCoverage: { name: string; used: boolean; weight?: number; adopt?: number }[]; // 공식 기능 목록(가중·채택도 포함). adopt=사용 횟수 기반 채택 단계(0~1)
  skillConcentration: number; // 스킬 호출 상위 1개 점유율 (쏠림). 호출이 적으면 신뢰도가 낮다
  skillUseTotal: number; // 스킬 총 호출 수 (쏠림 판단의 표본 크기)
  exploreShare: number; // 읽기·탐색 도구 비중 — 서브에이전트가 필요한 상황인지 판단
}

const clamp = (v: number): number => Math.max(5, Math.min(98, Math.round(v)));

export function buildScores(
  h: HeuristicInput
): { axis: string; score: number; desc: string; metrics: ScoreMetric[] }[] {
  const b = h.behavior;
  const n = Math.max(1, h.mainCount);
  const pctOf = (v: number) => Math.round(v * 100);
  const lg = b.learningSignals;

  // 공용 4축(프롬프트·학습·검증·기능)은 core-axes 단일 공식 → Codex와 같은 잣대로 직접 비교된다.
  const promptPts = promptScore({
    medianFirstPromptLen: b.medianFirstPromptLen,
    substantiveDirectiveShare: b.substantiveDirectiveShare,
    fileRefDirectiveShare: b.fileRefDirectiveShare,
    interruptPer100: b.escPer100,
  });
  // 학습 '양' = 이해 중심 활동 + 전용 학습 분야 블렌드. 질은 높아도 비중이 낮으면 점수가 눌린다
  const learnUsageShare = 0.65 * h.understandShare + 0.35 * h.studyShare;
  const learningPts = learningScore({
    chainPer100: lg.chainPer100,
    chain3Per100: lg.chain3Per100,
    grabPer100: lg.grabPer100,
    whyPer100: lg.whyPer100,
    confirmPer100: lg.confirmPer100,
    questionRatio: b.questionRatio,
    learnUsageShare,
  });
  const recoverPts = recoverScore({
    failureSessions: b.failureSessions,
    unresolvedFailSessions: b.unresolvedFailSessions,
    meanUnresolvedShare: b.meanUnresolvedShare,
    failureEvents: b.failureEvents,
  });
  // 수렴율 = 실패가 난 세션 중 끝까지 해결된 비율 (메트릭 표시·추천에서 재사용)
  const recovery = b.failureSessions > 0 ? (b.failureSessions - b.unresolvedFailSessions) / b.failureSessions : 0;
  // 기능 활용도: 폭(가중·채택)·쏠림·상황 적합성(서브에이전트·훅)·깊이. fit·weightedCoverage는 metrics에도 재사용.
  const usedSkills = h.inventory.skills.filter((s) => s.uses > 0).length;
  const wTotal = h.featureCoverage.reduce((a, f) => a + (f.weight ?? 1), 0) || 1;
  const wUsed = h.featureCoverage.reduce((a, f) => a + (f.adopt ?? (f.used ? 1 : 0)) * (f.weight ?? 1), 0);
  const weightedCoverage = wUsed / wTotal;
  // 상황 적합성: 작업이 그 기능을 필요로 하는데 안 쓰면 깎인다. 필요 없으면 중립(만점). 서브에이전트는 직접 호출만 인정.
  const needSubagent = h.exploreShare >= 0.35 || b.longNoCompactSessions >= 2 || b.avgSessionMin > 90;
  const subagentFit = needSubagent ? (b.subagentRuns > 0 ? 4 : 0) : 4;
  const needHook = b.correctionStormSessions >= 1 || b.directiveMsgs >= 30;
  const hookFit = needHook ? (h.inventory.hooks.length > 0 ? 4 : 0) : 4;
  const fit = subagentFit + hookFit;
  const featurePts = featureScore({
    weightedCoverage,
    skillConcentration: h.skillConcentration,
    skillUseTotal: h.skillUseTotal,
    usedSkills,
    depthExtra: b.topCommands.length, // 쓰는 커맨드 종류
    fitScore: fit,
  });

  // ── 도구 전용 2축: 컨텍스트 운용 · 비용·캐시 효율 (Claude 로그에만 있는 신호) ──
  const contextPts = clamp(
    80 -
      60 * (b.longNoCompactSessions / n) +
      15 * Math.min(1, (b.compactSessions / n) * 5) +
      // /clear·/compact로 작업을 끊는 습관(가점), 한 세션 정정 폭주(감점, 컨텍스트 오염)
      Math.min(8, b.clearCompactCommands) -
      Math.min(10, b.correctionStormSessions * 2) -
      (b.avgSessionMin > 120 ? 10 : 0)
  );
  // 비용 보강(agent-design): 탐색·간단 작업을 저렴 모델(Haiku)에 위임하면 소폭 가점
  const costPts = clamp(
    h.cacheHitRate * 100 - Math.max(0, h.recacheRate - 0.35) * 60 + Math.min(6, b.cheaperModelShare * 40)
  );

  return [
    {
      axis: '프롬프트 구체성',
      score: promptPts,
      desc: '요청에 맥락·제약을 담아 의도를 한 번에 전달하는가',
      metrics: [
        { label: '첫 메시지 길이 (세션 중앙값)', value: `${b.medianFirstPromptLen}자`, hint: '길수록 좋아요' },
        { label: '80자 이상 구체 지시 비중', value: `${pctOf(b.substantiveDirectiveShare)}%`, hint: '높을수록 좋아요' },
        { label: '파일·경로(@) 지목 비중', value: `${pctOf(b.fileRefDirectiveShare)}%`, hint: '높을수록 좋아요' },
        { label: 'Esc로 끊고 다시 지시', value: `${b.escPer100.toFixed(1)}회/100메시지`, hint: '적을수록 좋아요' },
      ],
    },
    {
      axis: '학습 주도성',
      score: learningPts,
      desc: '받은 답을 그대로 두지 않고 꼬리질문으로 파고드는가',
      metrics: [
        { label: '꼬리질문 체인 (이어 파고들기)', value: `${lg.chainPer100.toFixed(1)}회/100메시지`, hint: '많을수록 좋아요' },
        { label: '왜·원리를 묻는 질문', value: `${lg.whyPer100.toFixed(1)}회/100메시지`, hint: '많을수록 좋아요' },
        { label: '이해 확인 ("~란 거지?")', value: `${lg.confirmPer100.toFixed(1)}회/100메시지`, hint: '많을수록 좋아요' },
        { label: '질문 비율', value: `${pctOf(b.questionRatio)}%`, hint: '높을수록 좋아요 (보조 신호)' },
        { label: '학습에 쓰는 비중', value: `${pctOf(learnUsageShare)}%`, hint: '낮으면 위 점수가 깎여요' },
      ],
    },
    {
      axis: '오류 회복·수렴',
      score: recoverPts,
      desc: 'AI 작업이 실패했을 때(오류) 끝까지 잡아 해결하는가',
      metrics: [
        { label: '미해결로 끝난 세션', value: b.failureSessions < 3 ? '표본 적음' : `${pctOf(1 - recovery)}%`, hint: `오류가 난 세션 중 못 푼 채 끝낸 비율 (${b.failureSessions}개 중 ${b.unresolvedFailSessions}개). 영향이 가장 큼` },
        { label: '오류(실패) 이벤트', value: `${b.failureEvents}회`, hint: 'is_error 도구 결과. 회복의 분모(표본)' },
        { label: '오류가 난 세션', value: `${b.failureSessions}개`, hint: '회복력을 잴 표본 (3개 미만이면 중립)' },
      ],
    },
    {
      axis: '컨텍스트 운용',
      score: contextPts,
      desc: '대화가 커지기 전에 compact·clear로 끊어 토큰 낭비를 막는가',
      metrics: [
        { label: '2시간+ compact 없이 이어간 세션', value: `${b.longNoCompactSessions}개`, hint: '적을수록 좋아요 (영향이 가장 큼)' },
        { label: 'compact 쓴 세션', value: `${b.compactSessions}개`, hint: '많을수록 좋아요' },
        { label: '/clear·/compact로 끊은 횟수', value: `${b.clearCompactCommands}회`, hint: '많을수록 좋아요' },
        { label: '한 세션 3회+ 중단·정정 (컨텍스트 오염)', value: `${b.correctionStormSessions}개`, hint: '적을수록 좋아요' },
        { label: '평균 세션 길이', value: `${Math.round(b.avgSessionMin)}분`, hint: '너무 길지 않을수록 좋아요' },
      ],
    },
    {
      axis: '비용·캐시 효율',
      score: costPts,
      desc: '같은 컨텍스트를 다시 계산하지 않고 캐시에서 읽는 비율',
      metrics: [
        { label: '캐시 적중률', value: `${pctOf(h.cacheHitRate)}%`, hint: '높을수록 좋아요 (이 값이 곧 점수)' },
        { label: '캐시 재작성률', value: `${pctOf(h.recacheRate)}%`, hint: '낮을수록 좋아요' },
        { label: '저렴 모델(Haiku 등) 비중', value: `${pctOf(b.cheaperModelShare)}%`, hint: '높을수록 좋아요' },
      ],
    },
    {
      axis: '기능 활용도',
      score: featurePts,
      desc: '공식 기능을 내 작업에 맞게, 한쪽에 치우치지 않고 두루 쓰는가',
      metrics: [
        { label: '가중 채택 커버리지', value: `${pctOf(weightedCoverage)}%`, hint: '사용 횟수로 채택도를 매겨 가중(자주=만점·맛보기=0.4). 영향이 가장 큼' },
        { label: '자주 활용 / 써본 기능', value: `${h.featureCoverage.filter((f) => (f.adopt ?? (f.used ? 1 : 0)) >= 1).length} / ${h.featureCoverage.filter((f) => f.used).length} (총 ${h.featureCoverage.length})`, hint: '자주=10회+, 써봄=1회+' },
        { label: '스킬 쏠림 (상위 1개 비중)', value: h.skillUseTotal < 8 ? '표본 적음' : `${pctOf(h.skillConcentration)}%`, hint: '낮을수록 좋아요 (고루 쓰면 가점)' },
        { label: '상황 적합성', value: `${Math.round((fit / 8) * 100)}%`, hint: '탐색 많으면 서브에이전트, 정정 잦으면 훅을 갖췄는가' },
        { label: '30일 내 호출한 스킬', value: `${usedSkills}/${h.inventory.skills.length}`, hint: '많을수록 좋아요' },
        { label: '설정한 훅 / 서브에이전트 직접 호출', value: `${h.inventory.hooks.length}개 / ${b.subagentRuns}회`, hint: '서브에이전트는 직접 호출(Agent/Task)만 인정, 적합성에 반영돼요' },
      ],
    },
  ];
}

// 점수 기준 팝업 내용. buildScores의 공식을 바꾸면 여기 문장도 같이 바꾼다 (숫자가 코드와 1:1)
export function buildScoreCriteria(): AxisCriterion[] {
  return [
    promptCriterion([
      {
        label: 'Claude Code Best Practices',
        url: 'https://code.claude.com/docs/en/best-practices',
        grounds: '구체성과 정정(중단) 감소를 직접 연결 ("지시가 정확할수록 정정이 줄어든다")',
      },
      {
        label: 'Anthropic 프롬프트 엔지니어링 (Be clear and direct)',
        url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/be-clear-and-direct',
        grounds: '맥락 없는 동료가 읽어도 안 헷갈릴 만큼 구체적으로 + 의도·제약을 함께 담기',
      },
    ]),
    learningCriterion([
      {
        label: 'Dunlosky et al. 2013, Improving Students’ Learning (PSPI)',
        url: 'https://www.whz.de/fileadmin/lehre/hochschuldidaktik/docs/dunloskiimprovingstudentlearning.pdf',
        grounds:
          '왜·원리 질문(elaborative interrogation)과 이해 확인(self-explanation)이 학습을 강화, 고효용 전략으로 평가',
      },
    ]),
    recoverCriterion([
      {
        label: 'Claude Code Best Practices: Course correct early and often',
        url: 'https://code.claude.com/docs/en/best-practices',
        grounds: '에이전트가 어긋났을 때 일찍·자주 방향을 바로잡을수록 결과가 좋아진다 — 오류를 막힌 채 두지 말고 교정하라',
      },
      {
        label: 'Claude Code Best Practices: Give Claude a way to verify',
        url: 'https://code.claude.com/docs/en/best-practices',
        grounds: '변경 뒤 테스트·빌드로 결과를 확인시키면 실패를 잡아 고칠 기회가 생긴다(검증은 회복의 입구)',
      },
    ]),
    {
      axis: '컨텍스트 운용',
      what: '대화가 커지기 전에 compact·clear로 끊어 토큰 낭비를 막는가',
      base: '기본 80점에서 시작 (주로 감점으로 평가)',
      gains: [
        'compact로 정리하고 넘어간 세션이 많을수록',
        '/clear·/compact로 작업을 자주 끊어줄수록',
      ],
      penalties: [
        '2시간 넘게 정리 없이 이어간 세션이 많을수록 (가장 크게 깎임)',
        '한 세션에서 자꾸 끊고 고칠수록 (대화가 오염됨)',
        '평균 세션이 너무 길수록 (2시간 초과)',
      ],
      sources: [
        {
          label: 'Claude Code Best Practices',
          url: 'https://code.claude.com/docs/en/best-practices',
          grounds:
            '/clear·/compact 권장의 근거: "컨텍스트가 차면 성능이 저하된다", "깔끔한 세션이 정정 누적된 긴 세션을 거의 항상 이긴다"',
        },
        {
          label: 'Effective context engineering for AI agents',
          url: 'https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents',
          grounds: '토큰이 늘수록 정확도·회상이 떨어지는 "context rot" 개념',
        },
      ],
      calibrationNote:
        '120분 컷과 감점 가중은 우리 데이터 앵커. 자동 compaction이 동작한 세션은 수동 /compact가 없어도 낭비가 아닐 수 있어 디폴트 휴리스틱으로 본다.',
    },
    {
      axis: '비용·캐시 효율',
      what: '같은 컨텍스트를 다시 계산하지 않고 캐시에서 읽는 비율',
      base: '캐시 적중률이 곧 점수',
      gains: ['간단한 일을 저렴 모델(Haiku)에 맡길수록'],
      penalties: ['같은 내용을 캐시에서 못 읽고 자꾸 새로 계산할수록'],
      sources: [
        {
          label: 'Anthropic Prompt Caching 공식 문서',
          url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching',
          grounds: '캐시 읽기=입력가 0.1×, 쓰기=1.25×(5분)/2×(1시간), 기본 TTL 5분. 읽기 비율이 높을수록 절약',
        },
      ],
      calibrationNote:
        '캐시 적중률을 점수에 직결한 건 읽기가 약 10배 싸다는 공식 단가에 근거. 재작성 35% 컷과 ×60 가중은 우리 데이터 앵커.',
    },
    featureCriterion([
      {
        label: 'Claude Code Best Practices: Configure your environment',
        url: 'https://code.claude.com/docs/en/best-practices',
        grounds:
          'CLAUDE.md·훅·서브에이전트·스킬을 권장 셋업으로 명시 ("CLAUDE.md는 매 대화 시작 시 읽는 영구 컨텍스트", "훅은 결정적으로 보장")',
      },
      {
        label: 'Extend Claude Code (when to use which feature)',
        url: 'https://code.claude.com/docs/en/features-overview',
        grounds: '기능마다 쓰는 상황(트리거)이 다름을 공식 매핑 — 넓은 탐색은 서브에이전트, 매번 실행돼야 하는 건 훅 등',
      },
    ], '기능 활용도'),
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
  const recovery = b.failureSessions > 0 ? (b.failureSessions - b.unresolvedFailSessions) / b.failureSessions : 1;
  if (b.failureSessions >= 5 && recovery < 0.6) {
    out.push({
      id: 'recover',
      severity: 'mid',
      title: '오류를 끝까지 닫고 끝내기',
      now: `오류가 난 세션 중 ${Math.round(recovery * 100)}%만 해결된 채 끝났어요(미해결 ${b.unresolvedFailSessions}개). 에러가 뜬 상태로 멈추면 다음에 또 헤매요.`,
      better: '에러가 나면 원인을 짚고, 고친 뒤 같은 명령을 다시 돌려 통과를 확인하고 마무리하게 하세요.',
      script: '"에러가 나면 원인을 설명하고, 고친 다음 다시 실행해서 통과를 확인한 뒤 끝내줘"',
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
