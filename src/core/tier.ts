// 퍼센타일(서버가 준 "나보다 낮은 비율", 0~1) → LOL식 9단계 티어.
// 상위% = (1 - percentile) * 100. 인원을 9등분(각 티어 ≈ 11.11%)으로 균등 분배.

export interface Tier {
  key: string; // 영문 키 (CSS class·아이콘 매핑용)
  name: string; // 한글 표시명
  cutTopPct: number; // 이 티어의 상위 컷 (%, 기준 표시용)
  color: string; // 뱃지 기본색
}

// 상위 티어부터(0=최상위) 순서. 인원 9등분이라 컷은 균등.
const ORDER: Omit<Tier, 'cutTopPct'>[] = [
  { key: 'challenger', name: '챌린저', color: '#f5d142' },
  { key: 'grandmaster', name: '그랜드마스터', color: '#d63a3a' },
  { key: 'master', name: '마스터', color: '#b04ad6' },
  { key: 'diamond', name: '다이아몬드', color: '#5bc0eb' },
  { key: 'emerald', name: '에메랄드', color: '#3fbf6f' },
  { key: 'platinum', name: '플래티넘', color: '#4ec9b0' },
  { key: 'gold', name: '골드', color: '#e8b923' },
  { key: 'silver', name: '실버', color: '#9aa7b3' },
  { key: 'bronze', name: '브론즈', color: '#a9714b' },
];

// 인원 9등분: i번째(0=최상위) 티어의 상위 누적 컷 = (i+1)/9 * 100.
// topPct 가 처음으로 maxTopPct 이하가 되는 칸이 내 티어.
const LADDER: { maxTopPct: number; tier: Tier }[] = ORDER.map((t, i) => {
  const maxTopPct = ((i + 1) / ORDER.length) * 100;
  return { maxTopPct, tier: { ...t, cutTopPct: maxTopPct } };
});

export interface Standing {
  tier: Tier;
  topPct: number; // 내 상위 % (반올림 전 원값)
}

// percentile(0~1) → 티어 + 상위%
export function standingFor(percentile: number): Standing {
  const topPct = (1 - percentile) * 100;
  const row = LADDER.find((r) => topPct <= r.maxTopPct) ?? LADDER[LADDER.length - 1];
  return { tier: row.tier, topPct };
}

// 사다리 전체 (UI 에서 "다음 티어까지" 같은 표현에 쓸 수 있게 노출)
export function allTiers(): Tier[] {
  return LADDER.map((r) => r.tier);
}
