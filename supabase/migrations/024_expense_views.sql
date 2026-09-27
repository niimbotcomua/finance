-- Хто переглянув витрату: позначка ставиться, коли учасник розгортає витрату на сайті
-- або відкриває її кнопкою з Telegram. Автор витрати вважається тим, хто її бачив.
-- Скрипт можна виконувати повторно.

create table if not exists public.expense_views (
  expense_id bigint not null references public.expenses (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  viewed_at  timestamptz not null default now(),
  primary key (expense_id, user_id)
);

alter table public.expense_views enable row level security;

drop policy if exists "expense_views: учасники бачать" on public.expense_views;
create policy "expense_views: учасники бачать" on public.expense_views
  for select to authenticated
  using (exists (
    select 1 from public.expenses e
    where e.id = expense_id and private.is_group_member(e.group_id)
  ));

revoke all on public.expense_views from anon, authenticated;
grant select on public.expense_views to authenticated;

-- Позначити витрату переглянутою (лише учасник її групи; повторний перегляд оновлює час).
create or replace function public.mark_expense_viewed(eid bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.expenses e where e.id = eid and private.is_group_member(e.group_id)
  ) then
    raise exception 'Витрату не знайдено';
  end if;
  insert into public.expense_views (expense_id, user_id) values (eid, auth.uid())
  on conflict (expense_id, user_id) do update set viewed_at = now();
end;
$$;
revoke execute on function public.mark_expense_viewed(bigint) from public, anon;
grant execute on function public.mark_expense_viewed(bigint) to authenticated;

-- Автор нової витрати її вже бачив.
create or replace function private.expense_viewed_by_author()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.expense_views (expense_id, user_id) values (new.id, new.created_by)
  on conflict do nothing;
  return null;
end;
$$;

drop trigger if exists expense_viewed_by_author on public.expenses;
create trigger expense_viewed_by_author
  after insert on public.expenses
  for each row execute function private.expense_viewed_by_author();

-- Уже наявні витрати: автор їх бачив у момент створення.
insert into public.expense_views (expense_id, user_id, viewed_at)
select e.id, e.created_by, e.created_at from public.expenses e
where e.created_by is not null
on conflict do nothing;
