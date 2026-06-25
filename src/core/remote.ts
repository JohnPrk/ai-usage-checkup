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
// source('claude'|'codex')로 도구별 랭킹을 분리한다.
export function submitAndRank(
  installId: string,
  avg: number,
  axes: Record<string, number>,
  version: string,
  name: string,
  source: 'claude' | 'codex',
): Promise<RankResult> {
  return rpc<RankResult>('submit_and_rank', {
    p_install_id: installId,
    p_avg: avg,
    p_axes: axes,
    p_version: version,
    p_name: name || null,
    p_source: source,
  });
}

// 점수 재전송 없이 순위만 다시 조회 (홈 재진입 시 갱신용). 같은 source 안에서의 순위.
export function getRank(avg: number, source: 'claude' | 'codex'): Promise<RankResult> {
  return rpc<RankResult>('get_rank', { p_avg: avg, p_source: source });
}

// 리더보드: 한 페이지(limit/offset) + 내 행. (등수·닉네임·평균·축별점수·퍼센타일)이 돌아온다.
// installId 가 null 이면 서버가 '내 행'을 못 찾아 me=null 로 돌려준다(동의 전엔 내 식별자를 안 보냄).
// source 로 클로드/코덱스 랭킹을 분리해 조회한다.
export function leaderboard(
  installId: string | null,
  limit: number,
  offset: number,
  source: 'claude' | 'codex',
): Promise<LeaderboardResult> {
  return rpc<LeaderboardResult>('leaderboard', {
    p_install_id: installId,
    p_limit: limit,
    p_offset: offset,
    p_source: source,
  });
}

// 닉네임만 갱신. 다른 사람이 이미 쓰는 이름이면 {ok:false, reason:'taken'}(서버가 적용 안 함).
// 서버에 내 행이 없으면(아직 분석 전) 갱신은 no-op 이지만 중복 검사는 한다.
export function setName(installId: string, name: string): Promise<{ ok: boolean; reason?: string }> {
  return rpc<{ ok: boolean; reason?: string }>('set_name', { p_install_id: installId, p_name: name });
}

// 닉네임 사용 가능 여부(저장 전 미리 확인). 다른 사람이 쓰는 이름이면 false. 내 이름·빈 이름은 true.
export function nameAvailable(installId: string, name: string): Promise<boolean> {
  return rpc<boolean>('name_available', { p_install_id: installId, p_name: name });
}
