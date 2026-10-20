-- Supabase 프로젝트 food-waitmap(ref oazntcculpbxdvrnvafc)에 적용한 마이그레이션 원본
-- 맛집 대기시간: 입력별 30분 만료, 익명 ID당 식당별 1개, 2명 이상일 때만 평균(1분 반올림)
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron;

-- 외부에 노출되지 않는 설정(IP 해시용 솔트)
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table private.settings (
  id boolean primary key default true check (id),
  ip_salt text not null default encode(extensions.gen_random_bytes(32), 'hex')
);
insert into private.settings default values;

-- 대기시간 입력
create table public.wait_entries (
  id bigint generated always as identity primary key,
  place_id text not null check (char_length(place_id) between 1 and 200),
  anon_id uuid not null,
  wait_minutes int not null check (wait_minutes between 0 and 300 and wait_minutes % 5 = 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  unique (place_id, anon_id)
);
create index wait_entries_place_expires_idx on public.wait_entries (place_id, expires_at);
create index wait_entries_expires_idx on public.wait_entries (expires_at);

-- 요청 기록(요청 제한용). IP는 원문 대신 솔트 해시만 저장
create table public.wait_requests (
  id bigint generated always as identity primary key,
  anon_id uuid not null,
  ip_hash text,
  created_at timestamptz not null default now()
);
create index wait_requests_anon_idx on public.wait_requests (anon_id, created_at);
create index wait_requests_ip_idx on public.wait_requests (ip_hash, created_at);

-- 테이블 직접 접근 차단: RLS를 켜고 정책을 두지 않는다. 읽기/쓰기는 아래 함수로만
alter table public.wait_entries enable row level security;
alter table public.wait_requests enable row level security;
revoke all on public.wait_entries, public.wait_requests from anon, authenticated;

-- 요청한 클라이언트 IP의 해시(PostgREST가 넘겨주는 x-forwarded-for 첫 값)
create function private.client_ip_hash()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when ip is null or ip = '' then null
    else encode(extensions.digest(ip || (select ip_salt from private.settings), 'sha256'), 'hex') end
  from (
    select trim(split_part(
      (nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for'), ',', 1)) as ip
  ) h
$$;

-- 식당별 집계(서버 시각 기준으로 만료 제외)
create function public.get_wait_summaries(p_place_ids text[])
returns table (place_id text, average_minutes int, participant_count int, updated_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select e.place_id,
         case when count(*) >= 2 then round(avg(e.wait_minutes))::int end,
         count(*)::int,
         max(e.created_at)
  from public.wait_entries e
  where e.place_id = any (p_place_ids[1:50])
    and e.expires_at > now()
  group by e.place_id
$$;

-- 대기시간 입력: 검증 → 요청 제한 → 같은 사용자는 갱신(만료 시각도 새로) → 새 집계 반환
create function public.submit_wait(p_place_id text, p_anon_id uuid, p_minutes int)
returns table (place_id text, average_minutes int, participant_count int, updated_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ip text := private.client_ip_hash();
begin
  if p_place_id is null or char_length(p_place_id) not between 1 and 200 then
    raise exception 'invalid_place' using errcode = '22023';
  end if;
  if p_anon_id is null then
    raise exception 'invalid_user' using errcode = '22023';
  end if;
  if p_minutes is null or p_minutes < 0 or p_minutes > 300 or p_minutes % 5 <> 0 then
    raise exception 'invalid_minutes' using errcode = '22023';
  end if;

  -- 1분당 익명 ID 10회, IP 30회
  if (select count(*) from public.wait_requests r
        where r.anon_id = p_anon_id and r.created_at > now() - interval '1 minute') >= 10
     or (v_ip is not null and (select count(*) from public.wait_requests r
        where r.ip_hash = v_ip and r.created_at > now() - interval '1 minute') >= 30) then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  insert into public.wait_requests (anon_id, ip_hash) values (p_anon_id, v_ip);

  insert into public.wait_entries (place_id, anon_id, wait_minutes)
  values (p_place_id, p_anon_id, p_minutes)
  on conflict on constraint wait_entries_place_id_anon_id_key do update
    set wait_minutes = excluded.wait_minutes,
        created_at = now(),
        expires_at = now() + interval '30 minutes';

  return query select * from public.get_wait_summaries(array[p_place_id]);
end
$$;

revoke all on function private.client_ip_hash() from public, anon, authenticated;
revoke all on function public.get_wait_summaries(text[]) from public;
revoke all on function public.submit_wait(text, uuid, int) from public;
grant execute on function public.get_wait_summaries(text[]) to anon, authenticated;
grant execute on function public.submit_wait(text, uuid, int) to anon, authenticated;

-- 만료 데이터 정리(집계는 이미 expires_at으로 거르므로 저장 공간 정리용)
select cron.schedule(
  'waitmap-cleanup',
  '*/10 * * * *',
  $$delete from public.wait_entries where expires_at < now() - interval '1 hour';
    delete from public.wait_requests where created_at < now() - interval '1 day';$$
);
