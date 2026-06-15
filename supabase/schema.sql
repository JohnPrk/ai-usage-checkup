-- AI 리포트 — 익명 점수 랭킹 백엔드 (Supabase / Postgres)
--
-- 설계 원칙
--   * 서버에 올라가는 건 "숫자 + 사용자가 정한 닉네임"뿐.
--     avg_score(0~100) + 축별 점수(jsonb) + name(공개 닉네임, 없으면 '익명').
--     세션 내용·프롬프트·파일경로·프로젝트명은 절대 안 올라간다.
--   * 사용자 식별 = 익명 설치 UUID(install_id). 로그인 없음.
--     재분석하면 같은 install_id 행을 덮어쓴다(upsert) → "사용자당 최신 점수 1행".
--   * 모든 접근은 security definer RPC 로만. 테이블 직접 접근은 RLS 로 전면 차단
--     → 익명 키가 유출돼도 남의 점수를 raw 로 긁어가거나 통째로 지울 수 없다.
--   * 리더보드 RPC 는 (등수·닉네임·평균점수·퍼센타일)만 돌려준다.
--     install_id·축별점수는 절대 밖으로 내보내지 않는다.
--
-- 적용: Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여넣고 Run.
--       name 컬럼·leaderboard/set_name 함수가 새로 생기므로 기존 프로젝트도 한 번 재실행해야 한다.


-- 1) 점수 테이블 ---------------------------------------------------------------
create table if not exists public.scores (
  install_id  uuid        primary key,
  avg_score   int         not null check (avg_score between 0 and 100),
  axes        jsonb       not null default '{}'::jsonb,   -- {"프롬프트 구체성":78,"학습 주도성":73,...}
  name        text,                                       -- 사용자가 정한 공개 닉네임(없으면 읽을 때 '익명')
  app_version text,
  updated_at  timestamptz not null default now()
);
-- 이미 만들어져 있던 테이블이면 name 컬럼만 더한다(재실행 안전)
alter table public.scores add column if not exists name text;

-- 퍼센타일 계산(avg_score 비교 스캔)용 인덱스
create index if not exists scores_avg_idx on public.scores (avg_score);


-- 2) RLS: 테이블 직접 접근 전면 차단 --------------------------------------------
--    정책을 하나도 만들지 않으면 anon 역할의 직접 select/insert/update/delete 가
--    전부 거부된다. 데이터 접근은 아래 SECURITY DEFINER 함수로만 가능.
alter table public.scores enable row level security;


-- 3) 제출 + 순위 RPC: 분석 1회당 이거 하나만 호출하면 끝 -------------------------
--    내 점수를 upsert 하고, 그 자리에서 "나보다 낮은 사람 수 / 전체"를 같이 돌려준다.
--    p_name 이 비어 있으면(닉네임 미설정) 기존 이름을 지우지 않고 그대로 둔다.
drop function if exists public.submit_and_rank(uuid, int, jsonb, text);        -- 옛 4-arg 시그니처 제거
drop function if exists public.submit_and_rank(uuid, int, jsonb, text, text);
create or replace function public.submit_and_rank(
  p_install_id uuid,
  p_avg        int,
  p_axes       jsonb,
  p_version    text,
  p_name       text default null
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total  int;
  v_atmost int;   -- 나 이하(<=) 점수 인원. 동점을 "높은 쪽"으로 치기 위해 사용
  v_below  int;
  v_name   text := left(nullif(btrim(p_name), ''), 24);   -- 닉네임 최대 24자, 공백뿐이면 null
begin
  if p_avg is null or p_avg < 0 or p_avg > 100 then
    raise exception 'avg out of range: %', p_avg;
  end if;

  insert into public.scores (install_id, avg_score, axes, name, app_version, updated_at)
  values (p_install_id, p_avg, coalesce(p_axes, '{}'::jsonb), v_name, p_version, now())
  on conflict (install_id) do update
    set avg_score   = excluded.avg_score,
        axes        = excluded.axes,
        name        = coalesce(v_name, scores.name),   -- 새 닉네임이 있을 때만 갱신, 빈 값이면 기존 유지
        app_version = excluded.app_version,
        updated_at  = now();

  -- 동점은 "높은 쪽": 나 이하(<=) 인원을 세고, 거기서 나 1명을 빼 내 아래 순위 인원을 구한다.
  select count(*),
         count(*) filter (where avg_score <= p_avg)
    into v_total, v_atmost
    from public.scores;
  v_below := greatest(v_atmost - 1, 0);

  return json_build_object(
    'total',      v_total,                       -- 전체 표본 수
    'below',      v_below,                        -- 내 아래 순위 인원(동점은 내 위로 안 침)
    'percentile', case when v_total > 0           -- 0~1, 나 포함 "나 이하" 비율(동점 높은 쪽). 상위% = (1-percentile)*100
                       then round(v_atmost::numeric / v_total, 4)
                       else null end
  );
end;
$$;
revoke all on function public.submit_and_rank(uuid, int, jsonb, text, text) from public;
grant execute on function public.submit_and_rank(uuid, int, jsonb, text, text) to anon;


-- 4) (선택) 점수 재전송 없이 순위만 다시 조회 ----------------------------------
--    홈 화면을 다시 열었을 때, 내 저장된 avg 로 최신 순위만 갱신하고 싶을 때 사용.
create or replace function public.get_rank(p_avg int) returns json
language sql
security definer
set search_path = public
as $$
  -- 동점은 "높은 쪽": 나 이하(<=) 인원 기준. below 는 거기서 나 1명을 뺀 값.
  select json_build_object(
    'total',      count(*),
    'below',      greatest(count(*) filter (where avg_score <= p_avg) - 1, 0),
    'percentile', case when count(*) > 0
                       then round(count(*) filter (where avg_score <= p_avg)::numeric / count(*), 4)
                       else null end
  )
  from public.scores;
$$;
revoke all on function public.get_rank(int) from public;
grant execute on function public.get_rank(int) to anon;


-- 5) 리더보드: 상위 N 위 + 내 행 ----------------------------------------------
--    돌려주는 건 등수·닉네임·평균점수·퍼센타일(행별 티어 계산용)·isMe 뿐.
--    install_id·축별점수는 내보내지 않는다. 동점은 같은 등수(rank), 퍼센타일은 "나 이하" 비율(cume_dist).
drop function if exists public.leaderboard(uuid, int);
create or replace function public.leaderboard(p_install_id uuid, p_top int default 5)
returns json
language sql
security definer
set search_path = public
as $$
  with ranked as (
    select install_id,
           coalesce(nullif(btrim(name), ''), '익명') as name,
           avg_score,
           rank()      over (order by avg_score desc) as rnk,
           cume_dist() over (order by avg_score asc)  as percentile
    from public.scores
  )
  select json_build_object(
    'total', (select count(*) from ranked),
    'top', coalesce((
      select json_agg(json_build_object(
               'rnk',        rnk,
               'name',       name,
               'avg',        avg_score,
               'percentile', round(percentile::numeric, 4),
               'isMe',       (install_id = p_install_id)
             ) order by rnk asc, name asc)
      from (
        select install_id, rnk, name, avg_score, percentile
        from ranked
        order by rnk asc, name asc
        limit greatest(p_top, 1)
      ) t
    ), '[]'::json),
    'me', (
      select json_build_object(
               'rnk',        rnk,
               'name',       name,
               'avg',        avg_score,
               'percentile', round(percentile::numeric, 4),
               'isMe',       true
             )
      from ranked
      where install_id = p_install_id
    )
  );
$$;
revoke all on function public.leaderboard(uuid, int) from public;
grant execute on function public.leaderboard(uuid, int) to anon;


-- 6) 닉네임만 갱신 (점수 재전송 없이, 내 행이 이미 있을 때만) --------------------
--    닉네임을 바꾸면 즉시 리더보드에 반영되도록. 행이 없으면(아직 분석 전) 아무 일도 안 한다.
drop function if exists public.set_name(uuid, text);
create or replace function public.set_name(p_install_id uuid, p_name text) returns void
language sql
security definer
set search_path = public
as $$
  update public.scores
     set name = left(nullif(btrim(p_name), ''), 24)
   where install_id = p_install_id;
$$;
revoke all on function public.set_name(uuid, text) from public;
grant execute on function public.set_name(uuid, text) to anon;
