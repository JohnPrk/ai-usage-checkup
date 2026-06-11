import * as os from 'os';
import * as path from 'path';
import { AxisCriterion, Behavior, Inventory, Rec, SessionSummary } from './types';

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
  understandShare: number; // 이해 중심 활동(대화·설계 + 코드 읽기·검수) 토큰 비중 — 학습 '양'의 축
  studyShare: number; // '학습·이해' 의도 세션 비중
  featureCoverage: { name: string; used: boolean }[]; // 공식 기능 목록 중 기간 내 사용 여부 — 기능 활용도 커버리지
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
      15 * Math.min(1, (b.compactSessions / n) * 5) +
      // 보강: /clear·/compact로 작업을 끊는 습관(가점), 한 세션 정정 폭주(감점, 컨텍스트 오염)
      Math.min(8, b.clearCompactCommands) -
      Math.min(10, b.correctionStormSessions * 2) -
      (b.avgSessionMin > 120 ? 10 : 0)
  );
  // 프롬프트 구체성 = 의도를 한 번에 전달하는 습관. 첫 메시지 길이(셋업)뿐 아니라
  // 세션 중간 지시에 맥락이 담기는 비중(80자+ 지시)을 함께 본다. 포화점: 첫 메시지 180자, 본문 지시 28%.
  // Esc 중단은 출발이 어긋났다는 결과 신호라 감점. (정정 루프는 측정 결과 시도 크기에 비례해 신호로 안 씀 — 2026-06-11)
  // 보강(Best Practices): 길이뿐 아니라 지시가 구체 파일·경로(@)를 지목하고 검증 실행을 요청하는지를 직접 본다.
  // 재보정 2026-06-11: 기본점을 낮춰 곡선을 아래로(적당히 잘 쓰면 70~80, 90+는 거의 만점급). 캐시 축은 예외
  const promptScore = clamp(
    9 +
      Math.min(30, b.medianFirstPromptLen / 6.5) +
      Math.min(35, b.substantiveDirectiveShare * 116) +
      Math.min(12, b.fileRefDirectiveShare * 38) +
      Math.min(8, b.verifyDirectiveShare * 38) -
      Math.min(16, b.escPer100 * 1.9)
  );
  // 기능 활용도 = 공식 Claude Code 기능을 얼마나 두루 쓰는가(커버리지) + 자주 쓰는 자산의 깊이.
  // 커버리지는 analyze에서 탐지한 공식 기능 목록(현재 12개) 중 기간 내 사용 비율 (2026-06-11 재정의: 단순 보유 합산 → 커버리지 중심)
  const usedSkills = h.inventory.skills.filter((s) => s.uses > 0).length;
  const featTotal = Math.max(1, h.featureCoverage.length);
  const featUsed = h.featureCoverage.filter((f) => f.used).length;
  const coverage = featUsed / featTotal;
  const featureScore = clamp(
    2 +
      coverage * 56 +
      claudeMdHave * 8 +
      Math.min(7, usedSkills * 1.5) +
      Math.min(5, b.topCommands.length * 1.5)
  );
  // 비용 보강(agent-design): 탐색·간단 작업을 저렴 모델(Haiku)에 위임하면 소폭 가점
  const costScore = clamp(
    h.cacheHitRate * 100 - Math.max(0, h.recacheRate - 0.35) * 60 + Math.min(6, b.cheaperModelShare * 40)
  );
  // 학습 주도성 = 받은 답을 그대로 두지 않는 습관.
  // 파고들기(꼬리 체인 + 깊은 체인 + 이어받기) > 왜·원리 > 이해 확인 순 가중, 단순 질문율은 보조 신호.
  // 상한은 신호별 포화점: 한 신호가 비정상적으로 커도(긴 문서 붙여넣기 등) 점수를 독식하지 못하게 한다
  const lg = b.learningSignals;
  // 질문의 '질'(rate 기반 가점)에, '학습에 쓰는 비중'(양)을 곱한다.
  // 비중 = 이해 중심 활동 + 전용 학습 분야 블렌드. 질은 높아도 학습 비중이 낮으면 점수가 눌린다 (2026-06-11)
  const learnUsageShare = 0.65 * h.understandShare + 0.35 * h.studyShare;
  const learnVolumeFactor = 0.5 + 0.5 * Math.min(1, learnUsageShare / 0.3);
  const learnQuality =
    Math.min(35, (lg.chainPer100 + lg.chain3Per100 + lg.grabPer100) * 3) +
    Math.min(20, lg.whyPer100 * 1.75) +
    Math.min(8, lg.confirmPer100 * 5) +
    Math.min(10, b.questionRatio * 20);
  const learningScore = clamp(11 + learnQuality * learnVolumeFactor);

  return [
    {
      axis: '프롬프트 구체성',
      score: promptScore,
      desc: '요청에 맥락·제약을 담아 의도를 한 번에 전달하는가',
      detail: `첫 메시지 중앙값 ${b.medianFirstPromptLen}자 · 80자 이상 지시 ${pctOf(b.substantiveDirectiveShare)}% · 파일 지목 ${pctOf(b.fileRefDirectiveShare)}% · 검증 요청 ${pctOf(b.verifyDirectiveShare)}% · 중단 ${b.escPer100.toFixed(1)}회/100메시지`,
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
      detail: `2시간+ 무압축 세션 ${b.longNoCompactSessions}개 · compact 쓴 세션 ${b.compactSessions}개 · /clear·/compact ${b.clearCompactCommands}회 · 정정폭주 세션 ${b.correctionStormSessions}개 · 평균 ${Math.round(b.avgSessionMin)}분`,
    },
    {
      axis: '비용·캐시 효율',
      score: costScore,
      desc: '같은 컨텍스트를 다시 계산하지 않고 캐시에서 읽는 비율',
      detail: `캐시 적중 ${pctOf(h.cacheHitRate)}% · 캐시 재작성 ${pctOf(h.recacheRate)}% · 저렴 모델 ${pctOf(b.cheaperModelShare)}%`,
    },
    {
      axis: '기능 활용도',
      score: featureScore,
      desc: '공식 기능(스킬·훅·서브에이전트·MCP·플랜 모드 등)을 두루 쓰는가',
      detail: `공식 기능 ${featUsed}/${featTotal} 사용 · CLAUDE.md ${b.claudeMd.filter((c) => c.has).length}/${b.claudeMd.length} · 커맨드 ${b.topCommands.length}종 · 스킬 ${usedSkills}/${h.inventory.skills.length} 호출 · 훅 ${h.inventory.hooks.length}개 · 서브에이전트 ${b.subagentRuns}회`,
    },
  ];
}

// 점수 기준 팝업 내용. buildScores의 공식을 바꾸면 여기 문장도 같이 바꾼다 (숫자가 코드와 1:1)
export function buildScoreCriteria(): AxisCriterion[] {
  return [
    {
      axis: '프롬프트 구체성',
      what: '요청에 맥락·제약을 담아 의도를 한 번에 전달하는가',
      base: '기본 9점',
      gains: [
        '첫 메시지 길이(세션 중앙값): 6.5자당 1점, 195자에서 +30 만점',
        '80자 이상 지시 비중: 30%에서 +35 만점 (질문이나 "응·1번·고고" 같은 승인 답변은 지시로 안 침)',
        '구체 파일·경로(@) 지목 비중: 32%에서 +12 만점',
        '테스트·빌드 등 검증 실행을 함께 요청한 비중: 21%에서 +8 만점',
      ],
      penalties: ['Esc로 끊고 다시 지시: 100메시지당 1회마다 1.9점, 최대 16점'],
      sources: [
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
      ],
      calibrationNote:
        '길이·맥락량은 구체성의 대리지표이고, 첫 메시지 180자·지시 28% 같은 컷은 우리 데이터로 앵커링한 값(공식 문서엔 수치 기준 없음).',
    },
    {
      axis: '학습 주도성',
      what: '받은 답을 그대로 두지 않고 꼬리질문으로 파고드는가',
      base: '기본 11점. 아래 가점 합계에 "학습 비중"(0.5~1.0배)을 곱한다',
      gains: [
        '파고들기(2·3연속 질문 체인 + "근데/그럼" 이어받기): 100메시지당 12회쯤에서 +35 만점',
        '왜·원리·차이를 묻는 질문: 100메시지당 11회쯤에서 +20 만점',
        '이해 확인형("그러니까 ~라는 거지?"): 100메시지당 1.6회에서 +8 만점',
        '질문 비율(보조 신호): 50%에서 +10 만점',
      ],
      penalties: [
        '질문의 질이 높아도 학습에 쓰는 비중이 낮으면 가점이 눌림: 비중 0%면 가점 ×0.5, 30%↑면 ×1.0 (비중 = 이해 활동 토큰 65% + 전용 학습 분야 세션 35% 블렌드)',
      ],
      sources: [
        {
          label: 'Dunlosky et al. 2013, Improving Students’ Learning (PSPI)',
          url: 'https://www.whz.de/fileadmin/lehre/hochschuldidaktik/docs/dunloskiimprovingstudentlearning.pdf',
          grounds:
            '왜·원리 질문(elaborative interrogation)과 이해 확인(self-explanation)이 학습을 강화, 고효용 전략으로 평가',
        },
      ],
      calibrationNote:
        '이 축은 우리가 정의한 합성 지표다. 구성요소(왜 질문·이해 확인)는 학습과학으로 검증됐지만 Anthropic 공식 지표는 아니며, 100메시지당 횟수 컷은 우리 데이터 앵커.',
    },
    {
      axis: '컨텍스트 운용',
      what: '대화가 커지기 전에 compact·clear로 끊어 토큰 낭비를 막는가',
      base: '기본 80점 (감점 중심 축)',
      gains: [
        'compact를 쓴 세션이 전체의 20% 이상이면 +15 만점',
        '/clear·/compact로 작업을 끊은 횟수: 8회에서 +8 만점',
      ],
      penalties: [
        '2시간 넘게 compact 없이 이어간 세션 비중 × 60점',
        '한 세션에서 3회 이상 중단·정정(컨텍스트 오염): 세션당 2점, 최대 10점',
        '평균 세션이 120분을 넘으면 10점',
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
      base: '캐시 적중률이 곧 점수 (적중 96% → 96점)',
      gains: ['저렴 모델(Haiku)로 싼 작업을 위임한 토큰 비중: 15%에서 +6 만점'],
      penalties: ['캐시 재작성 비율이 35%를 넘는 만큼 × 60점 (예: 50%면 9점 감점)'],
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
    {
      axis: '기능 활용도',
      what: '공식 Claude Code 기능을 얼마나 두루 쓰는가(커버리지) + 자주 쓰는 자산의 깊이',
      base: '기본 2점',
      gains: [
        '공식 기능 커버리지 × 56점: 12개(CLAUDE.md·슬래시 커맨드·서브에이전트·스킬·훅·MCP·플랜 모드·할 일 추적·웹 검색·/init·컨텍스트 관리(/compact·/clear)·외부 CLI) 중 기간 내 쓴 비율',
        '주요 프로젝트 CLAUDE.md 보유 비율 × 8점 (깊이)',
        '스킬 실제 호출 깊이: 호출한 스킬 수 × 1.5, 최대 7점',
        '슬래시 커맨드 다양성: 종류 × 1.5, 최대 5점',
      ],
      penalties: [],
      sources: [
        {
          label: 'Claude Code Best Practices: Configure your environment',
          url: 'https://code.claude.com/docs/en/best-practices',
          grounds:
            'CLAUDE.md·훅·서브에이전트·스킬을 권장 셋업으로 명시 ("CLAUDE.md는 매 대화 시작 시 읽는 영구 컨텍스트", "훅은 결정적으로 보장")',
        },
      ],
      calibrationNote:
        '12개 기능 목록은 공식 docs(overview·memory·skills·hooks·mcp·sub-agents 등)에서 추린, 로그로 탐지 가능한 핵심 기능. 커버리지 ×56·깊이 가중은 우리 데이터 앵커. 단순 보유가 아니라 기간 내 실제 사용을 본다.',
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
