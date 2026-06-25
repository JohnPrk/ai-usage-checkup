-- AI 리포트 — 익명 점수 랭킹 백엔드 (Supabase / Postgres)
--
-- 설계 원칙
--   * 서버에 올라가는 건 "숫자 + 사용자가 정한 닉네임"뿐.
--     avg_score(0~100) + 축별 점수(jsonb) + name(공개 닉네임, 없으면 '익명').
--     세션 내용·프롬프트·파일경로·프로젝트명은 절대 안 올라간다.
--   * 사용자 식별 = 익명 설치 UUID(install_id). 로그인 없음.
--     재분석하면 같은 (install_id, source) 행을 덮어쓴다(upsert) → "도구별 사용자당 최신 점수 1행".
--   * source('claude'|'codex')로 클로드/코덱스 랭킹을 분리한다. 닉네임은 도구와 무관한 "사람"의
--     것이라 players 표(install_id 당 1행)에 두고, 리더보드가 join 해 양쪽에 같은 이름을 보인다.
--   * 모든 접근은 security definer RPC 로만. 테이블 직접 접근은 RLS 로 전면 차단
--     → 익명 키가 유출돼도 남의 점수를 raw 로 긁어가거나 통째로 지울 수 없다.
--   * 리더보드 RPC 는 (등수·닉네임·평균점수·축별점수·퍼센타일)을 돌려준다.
--     축별점수(axes)는 순위 공개에 동의한 참여자의 파생 수치라 상세 보기용으로 함께 공개한다.
--     install_id 는 절대 밖으로 내보내지 않는다(행별 isMe 플래그로만 내 행을 표시).
--
-- 적용: Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여넣고 Run.
--       0.9.5 에서 source 컬럼·players 표·RPC 시그니처(+source)가 새로 생기므로 한 번 재실행해야 한다.
--       시그니처는 옛 클라(0.9.1/0.9.4)가 source 없이 호출해도 default 'claude' 로 동작하도록 하위호환.


-- 1) 점수 테이블 ---------------------------------------------------------------
--    한 사람(install_id)이 도구별(source: 'claude'|'codex')로 각각 1행을 가질 수 있다.
--    → PK = (install_id, source). 클로드 랭킹과 코덱스 랭킹을 source 로 분리한다.
create table if not exists public.scores (
  install_id  uuid        not null,
  source      text        not null default 'claude',      -- 'claude' | 'codex' (도구별 랭킹 분리)
  avg_score   int         not null check (avg_score between 0 and 100),
  axes        jsonb       not null default '{}'::jsonb,   -- {"프롬프트 구체성":78,...} (도구마다 축이 다름)
  name        text,                                       -- (레거시) 닉네임 정본은 players. 새 RPC 는 이 컬럼을 안 읽는다.
  app_version text,
  updated_at  timestamptz not null default now(),
  primary key (install_id, source)
);
-- 이미 만들어져 있던(옛 PK=install_id) 테이블이면 source 추가 + PK 를 (install_id, source) 로 교체.
-- 기존 행은 default 로 source='claude' 가 채워진다. drop/add 는 이름 기준이라 재실행 안전.
alter table public.scores add column if not exists source text not null default 'claude';
alter table public.scores drop constraint if exists scores_pkey;
alter table public.scores add constraint scores_pkey primary key (install_id, source);

-- 퍼센타일 계산은 source 별로 끊어 읽으므로 (source, avg_score) 인덱스로 교체
drop index if exists public.scores_avg_idx;
create index if not exists scores_src_avg_idx on public.scores (source, avg_score);

-- 닉네임은 players 로 분리(아래) → scores 의 옛 닉네임 unique index 제거.
-- (한 사람이 클로드·코덱스 2행을 같은 닉네임으로 가지므로 scores 엔 unique 를 못 건다.)
drop index if exists public.scores_name_unique_idx;


-- 1-b) 닉네임(사람당 1개) ------------------------------------------------------
--    닉네임은 도구와 무관한 "사람"의 것. install_id 당 1행, 전역 유일(대소문자·공백 무시).
--    리더보드는 이 표를 join 해 이름을 가져온다 → 양쪽(클로드·코덱스) 랭킹에 같은 이름이 뜬다.
create table if not exists public.players (
  install_id uuid        primary key,
  name       text,
  updated_at timestamptz not null default now()
);
-- 닉네임 중복 방지(최종 방어선): 한 닉네임은 한 사람만. 동시 저장 경쟁은 이 인덱스가 막는다.
-- ⚠️ 이미 같은 닉네임 행이 둘 이상이면 인덱스 생성이 실패 → 중복 정리 후 재실행.
create unique index if not exists players_name_unique_idx
  on public.players (lower(btrim(name)))
  where name is not null and btrim(name) <> '';
-- 기존 scores 의 닉네임을 players 로 1회 이관(재실행 안전: 이미 있으면 건너뜀).
insert into public.players (install_id, name)
  select install_id, name from public.scores
   where name is not null and btrim(name) <> ''
  on conflict (install_id) do nothing;


-- 2) RLS: 테이블 직접 접근 전면 차단 --------------------------------------------
--    정책을 하나도 만들지 않으면 anon 역할의 직접 select/insert/update/delete 가
--    전부 거부된다. 데이터 접근은 아래 SECURITY DEFINER 함수로만 가능.
alter table public.scores enable row level security;
alter table public.players enable row level security;


-- 3) 제출 + 순위 RPC: 분석 1회당 이거 하나만 호출하면 끝 -------------------------
--    내 점수를 upsert 하고, 그 자리에서 "나보다 낮은 사람 수 / 전체"를 같이 돌려준다.
--    p_name 이 비어 있으면(닉네임 미설정) 기존 이름을 지우지 않고 그대로 둔다.
drop function if exists public.submit_and_rank(uuid, int, jsonb, text);              -- 옛 4-arg 시그니처 제거
drop function if exists public.submit_and_rank(uuid, int, jsonb, text, text);        -- 옛 5-arg(source 없음) 제거
create or replace function public.submit_and_rank(
  p_install_id uuid,
  p_avg        int,
  p_axes       jsonb,
  p_version    text,
  p_name       text default null,
  p_source     text default 'claude'   -- 'claude' | 'codex'. 옛 클라(0.9.1/0.9.4)는 안 보내 → 'claude'
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
  v_src    text := coalesce(nullif(btrim(p_source), ''), 'claude');
begin
  if p_avg is null or p_avg < 0 or p_avg > 100 then
    raise exception 'avg out of range: %', p_avg;
  end if;

  -- 닉네임 중복 방지: 다른 사람이 이미 쓰는 이름이면 적용하지 않고(점수만 올린다).
  -- 분석 업로드가 닉네임 충돌로 통째로 실패하지 않도록(앱은 name_available 로 미리 거른다).
  if v_name is not null and exists (
       select 1 from public.players
        where lower(btrim(name)) = lower(v_name) and install_id <> p_install_id
     ) then
    v_name := null;
  end if;

  -- 점수 upsert: (install_id, source) 단위. 같은 도구를 재분석하면 그 행만 덮어쓴다.
  insert into public.scores (install_id, source, avg_score, axes, app_version, updated_at)
  values (p_install_id, v_src, p_avg, coalesce(p_axes, '{}'::jsonb), p_version, now())
  on conflict (install_id, source) do update
    set avg_score   = excluded.avg_score,
        axes        = excluded.axes,
        app_version = excluded.app_version,
        updated_at  = now();

  -- 닉네임은 사람 단위(players). 새 닉네임이 있을 때만 갱신(빈 값이면 기존 유지).
  if v_name is not null then
    insert into public.players (install_id, name, updated_at)
    values (p_install_id, v_name, now())
    on conflict (install_id) do update set name = v_name, updated_at = now();
  end if;

  -- 순위는 같은 source 안에서만 계산한다(클로드 랭킹/코덱스 랭킹 분리).
  -- 동점은 "높은 쪽": 나 이하(<=) 인원을 세고, 거기서 나 1명을 빼 내 아래 순위 인원을 구한다.
  select count(*),
         count(*) filter (where avg_score <= p_avg)
    into v_total, v_atmost
    from public.scores
   where source = v_src;
  v_below := greatest(v_atmost - 1, 0);

  return json_build_object(
    'total',      v_total,                       -- 그 source 전체 표본 수
    'below',      v_below,                        -- 내 아래 순위 인원(동점은 내 위로 안 침)
    'percentile', case when v_total > 0           -- 0~1, 나 포함 "나 이하" 비율(동점 높은 쪽). 상위% = (1-percentile)*100
                       then round(v_atmost::numeric / v_total, 4)
                       else null end
  );
end;
$$;
revoke all on function public.submit_and_rank(uuid, int, jsonb, text, text, text) from public;
grant execute on function public.submit_and_rank(uuid, int, jsonb, text, text, text) to anon;


-- 4) (선택) 점수 재전송 없이 순위만 다시 조회 ----------------------------------
--    홈 화면을 다시 열었을 때, 내 저장된 avg 로 최신 순위만 갱신하고 싶을 때 사용.
-- p_source 는 옛 클라(get_rank(p_avg))가 안 보내면 'claude' → 같은 source 안에서만 순위 계산.
drop function if exists public.get_rank(int);
create or replace function public.get_rank(p_avg int, p_source text default 'claude') returns json
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
  from public.scores
  where source = coalesce(nullif(btrim(p_source), ''), 'claude');
$$;
revoke all on function public.get_rank(int, text) from public;
grant execute on function public.get_rank(int, text) to anon;


-- 5) 리더보드: 한 페이지(limit/offset) 순위 + 내 행 ----------------------------
--    돌려주는 건 등수·닉네임·평균점수·축별점수(axes)·퍼센타일(행별 티어 계산용)·isMe.
--    install_id 는 내보내지 않는다(isMe 로만 내 행 식별). 동점은 같은 등수(rank), 퍼센타일은 "나 이하" 비율(cume_dist).
--    p_limit/p_offset 로 한 페이지씩 끊어 돌려주고, total 로 전체 페이지 수를 계산한다.
--    내 행(me)은 페이지와 무관하게 항상 같이 내려보낸다(다른 페이지를 보고 있어도 내 순위는 표시).
-- p_source 는 옛 클라(3-arg)가 안 보내면 'claude'. 닉네임은 players 를 join 해 가져온다.
drop function if exists public.leaderboard(uuid, int);
drop function if exists public.leaderboard(uuid, int, int);
create or replace function public.leaderboard(
  p_install_id uuid,
  p_limit      int default 7,
  p_offset     int default 0,
  p_source     text default 'claude'
)
returns json
language sql
security definer
set search_path = public
as $$
  with ranked as (
    select s.install_id,
           coalesce(nullif(btrim(pl.name), ''), '익명') as name,
           s.avg_score,
           s.axes,
           rank()      over (order by s.avg_score desc) as rnk,
           cume_dist() over (order by s.avg_score asc)  as percentile
    from public.scores s
    left join public.players pl on pl.install_id = s.install_id
    where s.source = coalesce(nullif(btrim(p_source), ''), 'claude')
  )
  select json_build_object(
    'total', (select count(*) from ranked),
    'top', coalesce((
      select json_agg(json_build_object(
               'rnk',        rnk,
               'name',       name,
               'avg',        avg_score,
               'axes',       axes,
               'percentile', round(percentile::numeric, 4),
               'isMe',       (install_id = p_install_id)
             ) order by rnk asc, name asc)
      from (
        select install_id, rnk, name, avg_score, axes, percentile
        from ranked
        order by rnk asc, name asc
        limit  greatest(p_limit, 1)
        offset greatest(p_offset, 0)
      ) t
    ), '[]'::json),
    'me', (
      select json_build_object(
               'rnk',        rnk,
               'name',       name,
               'avg',        avg_score,
               'axes',       axes,
               'percentile', round(percentile::numeric, 4),
               'isMe',       true
             )
      from ranked
      where install_id = p_install_id
    )
  );
$$;
revoke all on function public.leaderboard(uuid, int, int, text) from public;
grant execute on function public.leaderboard(uuid, int, int, text) to anon;


-- 6) 닉네임 사용 가능 여부 조회 (저장 전 클라이언트가 미리 확인) ------------------
--    다른 사람이 이미 쓰는 이름이면 false. 내 이름(같은 install_id)이나 빈 이름은 true.
create or replace function public.name_available(p_install_id uuid, p_name text) returns boolean
language sql
security definer
set search_path = public
as $$
  select case
    when nullif(btrim(p_name), '') is null then true   -- 빈 닉네임은 항상 허용('익명')
    else not exists (
      select 1 from public.players
       where lower(btrim(name)) = lower(btrim(p_name))
         and install_id <> p_install_id
    )
  end;
$$;
revoke all on function public.name_available(uuid, text) from public;
grant execute on function public.name_available(uuid, text) to anon;


-- 7) 닉네임만 갱신 (점수 재전송 없이) ------------------------------------------
--    닉네임을 바꾸면 즉시 리더보드에 반영되도록. 내 행이 없으면(아직 분석 전) 갱신은 no-op 이지만
--    중복 검사는 그대로 한다(미리 점찍어둔 이름이 충돌하면 알려준다). 충돌이면 {ok:false,reason:'taken'}.
drop function if exists public.set_name(uuid, text);
create or replace function public.set_name(p_install_id uuid, p_name text) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := left(nullif(btrim(p_name), ''), 24);
begin
  if v_name is not null and exists (
       select 1 from public.players
        where lower(btrim(name)) = lower(v_name) and install_id <> p_install_id
     ) then
    return json_build_object('ok', false, 'reason', 'taken');
  end if;
  -- 닉네임은 사람 단위(players). 분석 전이라 점수 행이 없어도 닉네임은 미리 점찍어 둘 수 있다.
  insert into public.players (install_id, name, updated_at)
  values (p_install_id, v_name, now())
  on conflict (install_id) do update set name = v_name, updated_at = now();
  return json_build_object('ok', true);
end;
$$;
revoke all on function public.set_name(uuid, text) from public;
grant execute on function public.set_name(uuid, text) to anon;
