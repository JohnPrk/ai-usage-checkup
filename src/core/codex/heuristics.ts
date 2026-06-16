import { AxisCriterion, CodexBehavior, CodexSession, Inventory, Rec, ScoreMetric } from '../types';
import {
  featureScore,
  learningScore,
  promptScore,
  recoverScore,
  promptCriterion,
  learningCriterion,
  recoverCriterion,
  featureCriterion,
} from '../scoring/core-axes';

// 작업 의도 분류. Claude의 categorize와 골격은 같으나 Codex 활동 이름(명령 실행·apply_patch 편집 등)에 맞춘다.
const INTENT_LABELS = ['기능 개발', '버그 수정', '학습·이해', '리팩토링', '글쓰기', '환경 설정'];

export function categorizeCodex(s: CodexSession): string {
  const k: Record<string, number> = {};
  for (const label of INTENT_LABELS) k[label] = s.intentHits[label] ?? 0;
  const amsg = (n: string): number => s.activities[n]?.msgs ?? 0;
  const editMsgs = amsg('서버·스크립트 코드') + amsg('프론트 코드') + amsg('문서·설정 파일');
  const qRatio = s.humanMsgs > 0 ? s.questionMsgs / s.humanMsgs : 0;

  const doing: Record<string, number> = {
    '기능 개발': k['기능 개발'] + Math.min(4, editMsgs * 0.4),
    '버그 수정': k['버그 수정'] * 1.6,
    '리팩토링': k['리팩토링'] * 1.5,
    '환경 설정': k['환경 설정'] + Math.min(2, amsg('문서·설정 파일') * 0.3),
    '글쓰기': k['글쓰기'] * 1.5,
  };
  let bestDoing = '기능 개발';
  let bestVal = -1;
  for (const label of Object.keys(doing)) {
    if (doing[label] > bestVal) {
      bestVal = doing[label];
      bestDoing = label;
    }
  }
  const learn = k['학습·이해'] + (qRatio >= 0.6 ? 1.5 : 0);
  if (editMsgs >= 2) {
    if (learn >= bestVal * 1.6 && learn >= 4) return '학습·이해';
    if (bestVal >= 0.6) return bestDoing;
    return '기능 개발';
  }
  if (learn >= 1.5) return '학습·이해';
  if (bestVal >= 1) return bestDoing;
  return '기타';
}

export interface CodexHeuristicInput {
  behavior: CodexBehavior;
  inventory: Inventory;
  // 자산·기능 커버리지(가중·채택). 자동 보조도구(웹검색)는 weight 0.4, 직접 셋업은 1.0
  featureCoverage: { name: string; used: boolean; weight?: number; adopt?: number }[];
  skillConcentration: number; // 스킬 멘션 상위 1개 점유율(쏠림)
  skillUseTotal: number; // 스킬 멘션 총수(쏠림 판단 표본)
}

const clamp = (v: number): number => Math.max(5, Math.min(98, Math.round(v)));

// 5축 점수. 각 축 천장 98 정규화(Claude와 동일 정책). 임계값·가중치는 데이터 앵커(사람에 맞춰 튜닝 금지, 측정으로 보정).
export function buildCodexScores(
  h: CodexHeuristicInput
): { axis: string; score: number; desc: string; metrics: ScoreMetric[] }[] {
  const b = h.behavior;
  const lg = b.learningSignals;
  const pctOf = (v: number) => Math.round(v * 100);

  // 공용 4축(프롬프트·학습·검증·기능)은 core-axes 단일 공식 → Claude와 같은 잣대로 직접 비교된다.
  const promptPts = promptScore({
    medianFirstPromptLen: b.medianFirstPromptLen,
    substantiveDirectiveShare: b.substantiveDirectiveShare,
    fileRefDirectiveShare: b.fileRefDirectiveShare,
    interruptPer100: b.abortPer100,
  });
  const learningPts = learningScore({
    chainPer100: lg.chainPer100,
    chain3Per100: lg.chain3Per100,
    grabPer100: lg.grabPer100,
    whyPer100: lg.whyPer100,
    confirmPer100: lg.confirmPer100,
    questionRatio: b.questionRatio,
    learnUsageShare: b.learnUsageShare,
  });
  const recoverPts = recoverScore({
    failureSessions: b.failureSessions,
    unresolvedFailSessions: b.unresolvedFailSessions,
    meanUnresolvedShare: b.meanUnresolvedShare,
    failureEvents: b.failureEvents,
  });
  // 수렴율 = 실패가 난 세션 중 끝까지 해결된 비율 (메트릭 표시·추천에서 재사용)
  const recovery = b.failureSessions > 0 ? (b.failureSessions - b.unresolvedFailSessions) / b.failureSessions : 0;
  const usedSkills = h.inventory.skills.filter((s) => s.uses > 0).length;
  const wTotal = h.featureCoverage.reduce((a, f) => a + (f.weight ?? 1), 0) || 1;
  const wUsed = h.featureCoverage.reduce((a, f) => a + (f.adopt ?? (f.used ? 1 : 0)) * (f.weight ?? 1), 0);
  const weightedCoverage = wUsed / wTotal;
  // Codex엔 상황 적합성(서브에이전트·탐색) 신호가 없어 fitScore는 중립(8)으로 둔다.
  const featurePts = featureScore({
    weightedCoverage,
    skillConcentration: h.skillConcentration,
    skillUseTotal: h.skillUseTotal,
    usedSkills,
    depthExtra: 0,
  });

  // ── 도구 전용 2축: 자율 실행 신뢰 · 계획·구조화 (Codex 로그에만 있는 신호) ──
  // 자율: 도구 연쇄 깊이(위임) + 완수율 - 중단·롤백. approval_policy/sandbox는 값 고정이라 제외. 근거: GPT-5 agentic.
  const autonomyPts = clamp(
    35 + Math.min(30, b.avgToolChain * 2.4) + b.taskCompletionRate * 18 - Math.min(28, b.abortPer100 * 2.5)
  );
  // 계획: update_plan/goal로 복잡한 작업을 단계로 쪼개는가. 근거: Codex best practices("break into smaller steps").
  const planPts = clamp(8 + Math.min(60, b.planSessionShare * 150) + Math.min(15, (b.planUses + b.goalUses) * 0.6));

  return [
    {
      axis: '프롬프트 구체성',
      score: promptPts,
      desc: '요청에 맥락·제약·검증 기준을 담아 의도를 한 번에 전달하는가',
      metrics: [
        { label: '첫 메시지 길이 (세션 중앙값)', value: `${b.medianFirstPromptLen}자`, hint: '길수록 좋아요' },
        { label: '80자 이상 구체 지시 비중', value: `${pctOf(b.substantiveDirectiveShare)}%`, hint: '높을수록 좋아요' },
        { label: '파일·경로(@) 지목 비중', value: `${pctOf(b.fileRefDirectiveShare)}%`, hint: '높을수록 좋아요' },
        { label: '중단·롤백', value: `${b.abortPer100.toFixed(1)}회/100메시지`, hint: '적을수록 좋아요' },
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
        { label: '학습에 쓰는 비중', value: `${pctOf(b.learnUsageShare)}%`, hint: '낮으면 위 점수가 깎여요' },
      ],
    },
    {
      axis: '오류 회복·수렴',
      score: recoverPts,
      desc: 'Codex 작업이 실패했을 때(비정상 종료·오류) 끝까지 잡아 해결하는가',
      metrics: [
        { label: '미해결로 끝난 세션', value: b.failureSessions < 3 ? '표본 적음' : `${pctOf(1 - recovery)}%`, hint: `오류가 난 세션 중 못 푼 채 끝낸 비율 (${b.failureSessions}개 중 ${b.unresolvedFailSessions}개). 영향이 가장 큼` },
        { label: '오류(비0 종료) 이벤트', value: `${b.failureEvents}회`, hint: '실패한 도구 결과. 회복의 분모(표본)' },
        { label: '오류가 난 세션', value: `${b.failureSessions}개`, hint: '회복력을 잴 표본 (3개 미만이면 중립)' },
      ],
    },
    {
      axis: '자율 실행 신뢰',
      score: autonomyPts,
      desc: 'Codex에 끝까지 위임해 한 번에 처리하게 두는가 (도구 연쇄·완수율 ↔ 중단)',
      metrics: [
        { label: '턴당 평균 도구 연쇄', value: `${b.avgToolChain.toFixed(1)}개`, hint: '길수록 자율 위임 (영향이 가장 큼)' },
        { label: '작업 완수율', value: `${pctOf(b.taskCompletionRate)}%`, hint: 'task_complete / task_started' },
        { label: '중단·롤백', value: `${b.abortPer100.toFixed(1)}회/100메시지 (총 ${b.aborts}회)`, hint: '적을수록 좋아요' },
      ],
    },
    {
      axis: '계획·구조화',
      score: planPts,
      desc: 'update_plan·목표로 복잡한 작업을 단계로 쪼개 진행하는가',
      metrics: [
        { label: '계획·목표를 쓴 세션 비중', value: `${pctOf(b.planSessionShare)}%`, hint: '높을수록 좋아요 (영향이 가장 큼)' },
        { label: 'update_plan 사용', value: `${b.planUses}회`, hint: '복잡한 작업의 단계화' },
        { label: '목표(create/update_goal) 사용', value: `${b.goalUses}회`, hint: '높을수록 좋아요' },
      ],
    },
    {
      axis: '자산·기능 활용',
      score: featurePts,
      desc: 'AGENTS.md·스킬·훅·MCP·웹검색을 갖추고 두루 활용하는가',
      metrics: [
        { label: '가중 채택 커버리지', value: `${pctOf(weightedCoverage)}%`, hint: '직접 셋업(AGENTS.md·훅·MCP·스킬)은 만점 가중, 자동 보조(웹검색)는 0.4. 영향이 가장 큼' },
        { label: '자주 활용 / 써본 기능', value: `${h.featureCoverage.filter((f) => (f.adopt ?? (f.used ? 1 : 0)) >= 1).length} / ${h.featureCoverage.filter((f) => f.used).length} (총 ${h.featureCoverage.length})`, hint: '자주=10회+, 써봄=1회+' },
        { label: '스킬 쏠림 (상위 1개 비중)', value: h.skillUseTotal < 8 ? '표본 적음' : `${pctOf(h.skillConcentration)}%`, hint: '낮을수록 좋아요' },
        { label: '멘션한 스킬 종류', value: `${usedSkills}/${h.inventory.skills.length}`, hint: '많을수록 좋아요' },
        { label: '설정한 훅', value: `${h.inventory.hooks.length}개`, hint: '많을수록 좋아요' },
      ],
    },
  ];
}

// 점수 기준 팝업. buildCodexScores의 공식을 바꾸면 여기 문장도 같이 바꾼다.
// 공용 4축(프롬프트·학습·검증·기능)은 core-axes 빌더로 — Claude와 base/gains/penalties가 같고 sources만 Codex 문서다.
export function buildCodexScoreCriteria(): AxisCriterion[] {
  return [
    promptCriterion([
      {
        label: 'Codex Prompting / GPT-5 프롬프팅 가이드',
        url: 'https://developers.openai.com/codex/prompting',
        grounds: '구체적 맥락과 재현·검증 명령을 함께 담을수록 출력 품질이 높아진다',
      },
      {
        label: 'GPT-5 prompting guide',
        url: 'https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide',
        grounds: '명확한 지시·맥락이 에이전트 성능을 좌우 — instruction following 강조',
      },
    ]),
    learningCriterion([
      {
        label: 'Dunlosky et al. 2013, Improving Students’ Learning (PSPI)',
        url: 'https://www.whz.de/fileadmin/lehre/hochschuldidaktik/docs/dunloskiimprovingstudentlearning.pdf',
        grounds: '왜·원리 질문(elaborative interrogation)과 이해 확인(self-explanation)이 학습을 강화',
      },
    ]),
    recoverCriterion([
      {
        label: 'Best practices – Codex',
        url: 'https://developers.openai.com/codex/learn/best-practices',
        grounds: '"Codex는 자기 작업을 검증할 수 있을 때 더 좋은 결과" — 실패를 감지하면 고쳐서 다시 통과시키는 루프가 핵심',
      },
      {
        label: 'GPT-5 prompting guide',
        url: 'https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide',
        grounds: '변경 후 관련 검증을 돌려 실패를 잡고, 통과할 때까지 수정·재실행하도록 권장',
      },
    ]),
    {
      axis: '자율 실행 신뢰',
      what: 'Codex에 끝까지 위임해 한 번에 처리하게 두는가',
      base: '기본 35점',
      gains: ['한 턴에서 도구를 길게 연쇄해 끝까지 위임할수록', '작업 완수율이 높을수록'],
      penalties: ['턴을 자주 중단·롤백할수록'],
      sources: [
        {
          label: 'GPT-5 for developers (agentic)',
          url: 'https://openai.com/index/introducing-gpt-5-for-developers/',
          grounds: 'GPT-5는 도구 호출·장기 컨텍스트·지시 따르기를 강화해 에이전트로 끝까지 수행하도록 설계됨',
        },
        {
          label: 'Best practices – Codex',
          url: 'https://developers.openai.com/codex/learn/best-practices',
          grounds: 'Codex를 일회성 비서가 아니라 구성·개선하는 팀원처럼 다룰 때 가장 효과적',
        },
      ],
      calibrationNote:
        '도구 연쇄 길이·중단율 컷은 우리 데이터 앵커. approval_policy/sandbox는 값이 고정이라 신호에서 제외했다.',
    },
    {
      axis: '계획·구조화',
      what: 'update_plan·목표로 복잡한 작업을 단계로 쪼개 진행하는가',
      base: '기본 8점',
      gains: ['계획·목표 도구를 쓴 세션이 많을수록 (영향이 가장 큼)', 'update_plan·goal을 자주 쓸수록'],
      penalties: ['큰 작업을 단계화 없이 한 번에 던질수록 점수가 낮음'],
      sources: [
        {
          label: 'Best practices – Codex',
          url: 'https://developers.openai.com/codex/learn/best-practices',
          grounds: '복잡한 작업은 더 작고 집중된 단계로 쪼갤 때 Codex가 더 잘 처리하고 검토도 쉬움',
        },
        {
          label: 'Using PLANS.md for multi-hour problem solving',
          url: 'https://developers.openai.com/cookbook/articles/codex_exec_plans',
          grounds: '장시간 작업을 계획으로 구조화하는 패턴',
        },
      ],
      calibrationNote: '계획·목표 세션 비중 컷은 우리 데이터 앵커. 이 사용자 표본에선 사용량이 적어 진단(개선 여지) 성격이 강하다.',
    },
    featureCriterion([
      {
        label: 'Custom instructions with AGENTS.md – Codex',
        url: 'https://developers.openai.com/codex/guides/agents-md',
        grounds: 'AGENTS.md는 AI 팀원용 영구 온보딩 문서 — 명령·컨벤션·검증 절차를 담아두라',
      },
      {
        label: 'Agent Skills / MCP – Codex',
        url: 'https://developers.openai.com/codex/skills',
        grounds: '반복 작업은 스킬로, 외부 시스템은 MCP로 연결해 워크플로를 구성하라',
      },
    ], '자산·기능 활용'),
  ];
}

export function buildCodexRecommendations(h: CodexHeuristicInput): Rec[] {
  const b = h.behavior;
  const out: Rec[] = [];

  const recovery = b.failureSessions > 0 ? (b.failureSessions - b.unresolvedFailSessions) / b.failureSessions : 1;
  if (b.failureSessions >= 3 && recovery < 0.6) {
    out.push({
      id: 'codex-recover',
      severity: 'high',
      title: '오류를 끝까지 닫기',
      now: `명령·작업이 실패한 세션 중 ${Math.round(recovery * 100)}%만 해결된 채 끝났어요(미해결 ${b.unresolvedFailSessions}개). 비정상 종료를 남겨두면 다음에 또 막혀요.`,
      better: '에러가 나면 원인을 짚고, 고친 뒤 다시 실행해 통과를 확인하고 마무리하게 하세요.',
      script: 'AGENTS.md에 추가: "명령이 실패하면 원인을 설명하고, 고친 뒤 다시 실행해 통과를 확인하고 보고해줘"',
    });
  }
  if (b.planSessionShare < 0.15) {
    out.push({
      id: 'codex-plan',
      severity: 'mid',
      title: '복잡한 작업은 계획으로 쪼개기',
      now: `update_plan·목표로 단계를 나눈 세션이 ${Math.round(b.planSessionShare * 100)}%뿐이에요. 큰 작업을 한 번에 던지면 중간 점검이 어려워요.`,
      better: '여러 단계가 필요한 작업은 먼저 계획을 세우게 하고, 단계별로 확인하며 진행하세요.',
      script: '"이 작업을 단계로 나눠 계획부터 세우고, 각 단계 끝마다 멈춰서 확인해줘"',
    });
  }
  if (b.abortPer100 > 4) {
    out.push({
      id: 'codex-abort',
      severity: 'mid',
      title: '중단 후 재지시 줄이기',
      now: `메시지 100개당 ${b.abortPer100.toFixed(1)}회꼴로 턴을 중단·롤백했어요(총 ${b.aborts}회). 첫 지시에 제약이 빠졌다는 신호예요.`,
      better: '처음 요청에 범위, 건드리지 말 것, 완료 기준을 같이 적어 자율로 끝까지 가게 하세요.',
      script: '"<할 일>. 단 <건드리지 말 것>은 유지. 완료 기준: <기준>" 형태로 요청',
    });
  }
  const missing = b.medianFirstPromptLen < 40;
  if (missing) {
    out.push({
      id: 'codex-prompt',
      severity: 'mid',
      title: '첫 지시에 맥락 담기',
      now: `첫 메시지 길이 중앙값이 ${b.medianFirstPromptLen}자로 짧아요. 맥락이 적으면 Codex가 의도를 짐작하느라 헛돌아요.`,
      better: '무엇을·어디서·어떤 제약으로·완료 기준이 뭔지를 첫 메시지에 함께 적어주세요.',
      script: '"<대상 파일/폴더>에서 <할 일>. 제약: <…>. 끝나면 <검증>으로 확인" 형태',
    });
  }
  const inv = h.inventory;
  if (!inv.globalClaudeMd.exists) {
    out.push({
      id: 'codex-agents',
      severity: 'high',
      title: 'AGENTS.md부터 만들기',
      now: '전역 AGENTS.md가 없어요. 매 세션 같은 설명을 반복하게 돼요.',
      better: '자주 쓰는 명령·컨벤션·검증 절차를 AGENTS.md에 한 번만 적어두세요.',
      script: '~/.codex/AGENTS.md 또는 프로젝트 루트에 AGENTS.md 생성 (명령 → 테스트 → 배포 → 디버그 순)',
    });
  }
  if (inv.hooks.length === 0) {
    out.push({
      id: 'codex-hooks',
      severity: 'mid',
      title: '반복 확인은 훅으로',
      now: '설정된 훅이 없어요. 매번 손으로 확인하는 규칙은 자동화할 수 있어요.',
      better: 'PostToolUse 훅으로 파일 저장 직후 검사를, Stop 훅으로 종료 알림을 걸어보세요.',
      script: '~/.codex/hooks.json에 Write|Edit 후 lint를 돌리는 PostToolUse 훅 추가',
    });
  }

  if (out.length === 0) {
    out.push({
      id: 'codex-good',
      severity: 'mid',
      title: '기본기는 탄탄해요',
      now: '큰 낭비 패턴이 안 보여요.',
      better: '계획 도구와 스킬을 조금 더 적극적으로 써보면 더 좋아져요.',
      script: '"이 작업을 update_plan으로 단계화해서 진행해줘"',
    });
  }
  return out.slice(0, 3);
}
