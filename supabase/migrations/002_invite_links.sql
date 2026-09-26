-- Посилання-запрошення до групи: будь-хто з посиланням може приєднатися після входу.
-- Скрипт можна виконувати повторно.

alter table public.groups
  add column if not exists invite_token uuid not null default gen_random_uuid();
create unique index if not exists groups_invite_token_key on public.groups (invite_token);

-- Назва групи за посиланням — щоб показати «Вас запрошено до …» ще до входу.
create or replace function public.get_group_invite(token uuid)
returns table (group_id bigint, name text, member_count bigint, already_member boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select
    g.id,
    g.name,
    (select count(*) from public.group_members where group_id = g.id),
    exists (select 1 from public.group_members where group_id = g.id and user_id = auth.uid())
  from public.groups g
  where g.invite_token = token;
$$;

create or replace function public.join_group(token uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  gid bigint;
begin
  if auth.uid() is null then
    raise exception 'Потрібно увійти';
  end if;
  select id into gid from public.groups where invite_token = token;
  if gid is null then
    raise exception 'Посилання-запрошення недійсне або застаріле';
  end if;
  insert into public.group_members (group_id, user_id)
  values (gid, auth.uid())
  on conflict (group_id, user_id) do nothing;
  return gid;
end;
$$;

-- Створює нове посилання; старе перестає працювати.
create or replace function public.reset_group_invite(gid bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_token uuid := gen_random_uuid();
begin
  if not private.is_group_member(gid) then
    raise exception 'Групу не знайдено';
  end if;
  update public.groups set invite_token = new_token where id = gid;
  return new_token;
end;
$$;

-- Підказка про посилання, якщо користувача з таким email ще немає.
create or replace function public.add_group_member(gid bigint, member_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_member uuid;
begin
  if not private.is_group_member(gid) then
    raise exception 'Групу не знайдено';
  end if;
  select id into new_member from public.profiles where lower(email) = lower(trim(member_email));
  if new_member is null then
    raise exception 'Цей email ще не зареєстрований. Надішліть людині посилання-запрошення — вона зареєструється і одразу потрапить у групу.';
  end if;
  if exists (select 1 from public.group_members where group_id = gid and user_id = new_member) then
    raise exception 'Користувач уже є учасником групи';
  end if;
  insert into public.group_members (group_id, user_id) values (gid, new_member);
  return new_member;
end;
$$;

revoke execute on function
  public.get_group_invite(uuid),
  public.join_group(uuid),
  public.reset_group_invite(bigint)
from public, anon, authenticated;
grant execute on function public.get_group_invite(uuid) to anon, authenticated;
grant execute on function public.join_group(uuid), public.reset_group_invite(bigint) to authenticated;
