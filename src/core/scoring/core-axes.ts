// 공용 4축의 점수 공식. Claude·Codex가 이 함수를 똑같이 호출하므로 두 도구의
// 프롬프트·학습·오류회복·기능 점수는 같은 잣대로 매겨져 직접 비교된다.
// 표현(metrics·desc 문장)은 도구마다 신호 이름이 달라(예: apply_patch vs Edit) 각 heuristics에서 조립하고,
// 여기서는 '숫자'만 책임진다. 임계값·가중치는 데이터 앵커(사람에 맞춰 튜닝 금지) — buildScoreCriteria 문장과 1:1.
import { AxisCriterion, AxisSource } from '../types';

const clamp = (v: number): number => Math.max(5, Math.min(98, Math.round(v)));
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const min = Math.min;

// ── 축1: 프롬프트 구체성 ──────────────────────────────────────────────
// 첫 메시지 길이 + 본문 지시의 구체성(80자+ 비중·파일 지목) - 중단(Esc/롤백).
// 검증 요청은 '검증·반영' 축으로 분리됐다(예전엔 여기 min(8,…) 항이 있었다). gain 만점 77 → ×(89/77)로 천장 98 정규화.
export interface PromptScoreInput {
  medianFirstPromptLen: number;
  substantiveDirectiveShare: number;
  fileRefDirectiveShare: number;
  interruptPer100: number; // Claude=Esc, Codex=turn_aborted+rolled_back
}
export function promptScore(p: PromptScoreInput): number {
  return clamp(
    9 +
      (min(30, p.medianFirstPromptLen / 6.5) +
        min(35, p.substantiveDirectiveShare * 116) +
        min(12, p.fileRefDirectiveShare * 38)) *
        (89 / 77) -
      min(16, p.interruptPer100 * 1.9)
  );
}

// ── 축2: 학습 주도성 ──────────────────────────────────────────────────
// 받은 답을 그대로 두지 않는 질문 패턴(질) × 학습에 쓰는 비중(양). 신호는 도구와 무관한 사람 메시지 텍스트.
export interface LearningScoreInput {
  chainPer100: number;
  chain3Per100: number;
  grabPer100: number;
  whyPer100: number;
  confirmPer100: number;
  questionRatio: number;
  learnUsageShare: number; // 학습 '양' 비중 (Claude=이해활동+학습세션 블렌드, Codex=학습세션 비중)
}
export function learningScore(l: LearningScoreInput): number {
  const volumeFactor = 0.5 + 0.5 * min(1, l.learnUsageShare / 0.3);
  const quality =
    (min(35, (l.chainPer100 + l.chain3Per100 + l.grabPer100) * 3) +
      min(20, l.whyPer100 * 1.75) +
      min(8, l.confirmPer100 * 5) +
      min(10, l.questionRatio * 20)) *
    (87 / 73);
  return clamp(11 + quality * volumeFactor);
}

// ── 축3: 오류 회복·수렴 ───────────────────────────────────────────────
// AI 작업이 실패했을 때(도구 오류·비정상 종료) 끝까지 잡아 해결하는가. "테스트를 돌렸나"(검증)가 아니라
// "틀어진 걸 받아 수렴시켰나"(반영)를 잰다. 신호: 실패 이벤트(Claude=is_error 도구 결과 / Codex=비0 종료코드)와
// 그 실패가 이후 성공으로 '닫혔는지'. 실패 표본이 적으면 회복력을 잴 수 없어 중립으로 둔다(밀도는 도구 아닌 사용자별로 갈림).
const RECOVER_MIN_SAMPLE = 3; // 실패가 이만큼도 없으면 회복력 측정 불가 → 중립
const RECOVER_NEUTRAL = 70; // 표본 적을 때의 중립 점수(감점도 가점도 아님)
const RECOVER_PENALTY = 120; // 오목 곡선 계수: 98 천장에서 '버림 지수'에 비례해 깎는 양
const RECOVER_EXP = 0.65; // 오목 지수(<1): 0 근처 가파름·멀수록 완만 — 낮은 미해결율도 냉정히 끌어내리되 하위 변별 유지
export interface RecoverScoreInput {
  failureSessions: number; // 실패(오류·비정상 종료)가 1회+ 난 세션 수 — 회복력의 표본
  unresolvedFailSessions: number; // 그중 실패를 해결 못한 채 끝난 세션 수
  meanUnresolvedShare: number; // 실패 세션별 (미해결/실패) 평균 — 버릴 때 통째로 버리는 '심각도'(균등가중)
  failureEvents: number; // 실패 이벤트 총수(표시·표본용, 점수엔 직접 안 씀)
}
export function recoverScore(r: RecoverScoreInput): number {
  if (r.failureSessions < RECOVER_MIN_SAMPLE) return RECOVER_NEUTRAL;
  // 두 신호의 평균을 '버림 지수'로: sessionUR(깨진 채 끝낸 빈도) + meanUnresolvedShare(버릴 때의 심각도).
  // 98 천장에서 오목하게 깎는다 — 실패 '횟수'는 안 벌하고(어려운 일 많이 하면 실패도 많다) 오직 '남겨둔' 실패만 깎되,
  // 선형으론 낮은 미해결율을 냉정히 끌어내리면 하위 구간이 다 바닥에 처박혀서, 0 근처 가파른 오목 곡선을 쓴다.
  const sessionUR = r.unresolvedFailSessions / r.failureSessions;
  const abandonIdx = (sessionUR + r.meanUnresolvedShare) / 2;
  return clamp(98 - RECOVER_PENALTY * Math.pow(abandonIdx, RECOVER_EXP));
}

// ── 축4: 기능/자산 활용 ───────────────────────────────────────────────
// 폭(가중·채택 커버리지) + 쏠림 적음(분포) + 상황 적합성 + 깊이. 천장 98 = 2 + 52 + 30 + 8 + 6.
// fitScore: 작업이 필요로 하는 기능을 갖췄는가(Claude=서브에이전트·훅 적합성 0..8). 신호가 없으면 중립 8.
export interface FeatureScoreInput {
  weightedCoverage: number; // wUsed/wTotal (가중×채택)
  skillConcentration: number; // 상위 1개 스킬 점유율
  skillUseTotal: number; // 쏠림 판단 표본
  usedSkills: number; // 호출/멘션한 스킬 종류
  depthExtra: number; // 깊이 보조 신호 종류 수 (Claude=커맨드 종류, Codex=0)
  fitScore?: number; // 0..8, 없으면 중립 8
}
export function featureScore(f: FeatureScoreInput): number {
  const divFactor =
    f.skillUseTotal < 8 ? 0.7 : clamp01((0.7 - f.skillConcentration) / (0.7 - 0.3));
  const breadth = f.weightedCoverage * 52;
  const diversity = divFactor * 30;
  const fit = f.fitScore ?? 8;
  const depth = min(4, f.usedSkills * 0.8) + min(2, f.depthExtra * 0.6);
  return clamp(2 + breadth + diversity + fit + depth);
}

// ── 점수 기준 팝업: 공용 4축의 설명 문장. base/gains/penalties는 두 도구 공통,
//    sources(공식 문서 링크)만 도구별로 주입한다. 공식을 바꾸면 여기 calibrationNote도 같이 바꾼다.
export function promptCriterion(sources: AxisSource[]): AxisCriterion {
  return {
    axis: '프롬프트 구체성',
    what: '요청에 맥락·제약을 담아 의도를 한 번에 전달하는가',
    base: '기본 9점',
    gains: ['첫 메시지를 자세히 길게 쓸수록', '구체적인 지시(긴 문장)를 많이 줄수록', '파일·경로를 정확히 짚을수록'],
    penalties: ['도중에 끊고(Esc·중단) 다시 지시할수록'],
    sources,
    calibrationNote:
      '길이·맥락량은 구체성의 대리지표이고 만점 도달점은 우리 데이터 앵커. 검증 요청은 별도 축(검증·반영)으로 분리했다. 천장은 다른 축과 같은 98로 정규화(gain×89/77).',
  };
}
export function learningCriterion(sources: AxisSource[]): AxisCriterion {
  return {
    axis: '학습 주도성',
    what: '받은 답을 그대로 두지 않고 꼬리질문으로 파고드는가',
    base: '기본 11점에서 시작',
    gains: [
      '받은 답에 꼬리질문으로 더 파고들수록',
      '왜·원리·차이를 자주 물을수록',
      '"~라는 거지?"처럼 이해를 되짚을수록',
      '질문을 많이 던질수록 (보조 신호)',
    ],
    penalties: ['학습보다 단순 작업에 치우칠수록 위 가점이 깎임'],
    sources,
    calibrationNote:
      '우리가 정의한 합성 지표다. 구성요소(왜 질문·이해 확인)는 학습과학으로 검증됐지만 공식 지표는 아니며, 100메시지당 횟수 컷은 우리 데이터 앵커. 천장은 98로 정규화(learnQuality×87/73). 신호는 사람 메시지 텍스트라 도구와 무관하게 같은 잣대로 잰다.',
  };
}
export function recoverCriterion(sources: AxisSource[]): AxisCriterion {
  return {
    axis: '오류 회복·수렴',
    what: 'AI 작업이 실패했을 때(오류·비정상 종료) 끝까지 잡아 해결하는가',
    base: `만점 98점에서 시작 (실패 표본이 ${RECOVER_MIN_SAMPLE}개 미만이면 ${RECOVER_NEUTRAL}점 중립)`,
    gains: ['오류가 난 세션을 끝까지 수렴(이후 성공으로 닫힘)시킬수록 98점에 가까워짐 (영향이 가장 큼)'],
    penalties: [
      '오류를 해결 못 한 채 세션을 끝낼수록 (버리는 빈도)',
      '한 세션의 실패를 통째로 남겨둘수록 (버리는 심각도)',
    ],
    sources,
    calibrationNote:
      '실패 감지(Claude=is_error 도구 결과, Codex=비0 종료코드)와 "수렴=실패 이후 성공 도구결과로 닫힘" 판정은 우리 데이터 앵커. 점수는 98 천장에서 "버림 지수"(세션 미해결율과 세션별 미해결 비율의 평균)를 오목하게(98 − 120·지수^0.65) 깎는다 — 선형이면 낮은 미해결율을 냉정히 반영하려 기울기를 키울 때 중간·하위가 모두 바닥에 처박혀 변별이 사라져서, 0 근처는 가파르고 멀어질수록 완만한 곡선을 택했다. 실패가 적은 세션은 회복력을 잴 표본이 없어 중립으로 둔다 — 신호 밀도는 도구가 아니라 사용자별로 갈린다(채팅 위주면 양쪽 다 얇다). 실패 횟수 자체는 벌하지 않고 남겨둔 실패만 깎는다. 두 도구 동일 공식.',
  };
}
export function featureCriterion(sources: AxisSource[], axis = '기능·자산 활용'): AxisCriterion {
  return {
    axis,
    what: '공식 기능을 내 작업에 맞게, 한쪽에 치우치지 않고 두루 쓰는가',
    base: '기본 2점 (천장 98 = 폭 52 + 쏠림 30 + 적합성 8 + 깊이 6)',
    gains: [
      '직접 셋업하는 기능(훅·서브에이전트·MCP·플랜/AGENTS.md 등)을 두루 쓸수록 (영향이 가장 큼)',
      '한 기능을 자주 쓸수록 (10회+ 자주=만점, 5~9 가끔=0.7, 1~4 맛보기=0.4)',
      '스킬이 한 개에 몰리지 않고 고루 퍼질수록',
      '작업이 필요로 하는 기능을 갖출수록',
    ],
    penalties: [
      '특정 스킬 하나에 쏠릴수록',
      '한두 번 써본 기능은 부분만 인정(자주 써야 만점), 0회는 미인정',
      '자동으로 불리는 보조도구(MCP·웹검색 등)는 가중치를 낮춰 직접 활용과 구분',
    ],
    sources,
    calibrationNote:
      '가중치(자동 보조 0.4 vs 직접 셋업 1.0), 쏠림 컷, 채택 단계는 우리 데이터 앵커. 천장은 98로 정규화. fitScore(상황 적합성)는 도구가 줄 수 있으면 반영, 없으면 중립.',
  };
}
