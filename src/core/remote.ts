// Supabase 익명 랭킹 백엔드 연동.
// 서버로 나가는 건 "숫자 + 사용자가 정한 닉네임"뿐 — avg 점수 + 축별 점수(Record<string,number>) + 앱 버전 + 닉네임.
// 세션 내용·프롬프트·파일경로·프로젝트명은 절대 보내지 않는다.

import { RankResult, LeaderboardResult } from './types';

const SUPABASE_URL = 'https://xpjdftkjihjerygdgjmg.supabase.co';
// anon public 키: 클라에 박히는 "공개" 키다. RLS + SECURITY DEFINER RPC 로 보호되며
// service_role(마스터 키)이 아니라서 이 키로는 테이블을 raw 로 읽거나 지울 수 없다.
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhwamRmdGtqaWhqZXJ5Z2Rnam1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzMjI2NjQsImV4cCI6MjA5Njg5ODY2NH0.dj2ImM8mzaVqZbCydG7GKlCSOoVBZ-h316lN9mCqZIo';

const HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
};

async function rpc<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${fn} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

// 내 점수 저장(upsert) + 순위를 한 번에. 분석 1회당 이거 한 번 호출. name 은 공개 닉네임(없으면 null).
export function submitAndRank(
  installId: string,
  avg: number,
  axes: Record<string, number>,
  version: string,
  name: string,
): Promise<RankResult> {
  return rpc<RankResult>('submit_and_rank', {
    p_install_id: installId,
    p_avg: avg,
    p_axes: axes,
    p_version: version,
    p_name: name || null,
  });
}

// 점수 재전송 없이 순위만 다시 조회 (홈 재진입 시 갱신용).
export function getRank(avg: number): Promise<RankResult> {
  return rpc<RankResult>('get_rank', { p_avg: avg });
}

// 리더보드: 상위 top 위 + 내 행. (등수·닉네임·평균·퍼센타일)만 돌아온다.
export function leaderboard(installId: string, top: number): Promise<LeaderboardResult> {
  return rpc<LeaderboardResult>('leaderboard', { p_install_id: installId, p_top: top });
}

// 닉네임만 갱신(void 반환이라 본문을 파싱하지 않는다). 서버에 내 행이 없으면 no-op.
export async function setName(installId: string, name: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/set_name`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ p_install_id: installId, p_name: name }),
  });
  if (!res.ok) throw new Error(`set_name ${res.status}: ${await res.text()}`);
}
