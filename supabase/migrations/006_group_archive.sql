-- Архів груп.
-- Кожен учасник може сховати групу в архів лише для себе — і лише коли в ній усі розрахувалися.
-- Якщо в архівній групі знову з'являються борги, вона сама повертається до списку активних.
-- Скрипт можна виконувати повторно.

alter table public.group_members add column if not exists archived_at timestamptz;

-- Чи розрахувалися в групі всі учасники (баланс кожного — нуль).
create or replace function private.group_settled(gid bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
    from (
      select e.paid_by as user_id, e.amount as delta from public.expenses e where e.group_id = gid
      union all
      select s.user_id, -s.amount from public.expense_shares s join public.expenses e on e.id = s.expense_id
      where e.group_id = gid
      union all
      select t.from_user, t.amount from public.settlements t where t.group_id = gid
      union all
      select t.to_user, -t.amount from public.settlements t where t.group_id = gid
    ) x
    group by x.user_id
    having sum(x.delta) <> 0
  );
$$;

-- Список моїх груп: як my_groups(), плюс дата створення та чи група в моєму архіві.
create or replace function public.group_list()
returns table (
  id bigint, name text, currency text, member_count bigint, my_balance bigint,
  created_at timestamptz, archived boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select g.id, g.name, g.currency, g.member_count, g.my_balance, gr.created_at,
    m.archived_at is not null and private.group_settled(g.id)
  from public.my_groups() g
  join public.groups gr on gr.id = g.id
  join public.group_members m on m.group_id = g.id and m.user_id = auth.uid()
  order by gr.created_at desc, g.id desc;
$$;

-- Перенести групу в мій архів або повернути з нього.
create or replace function public.set_group_archived(gid bigint, archived boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_group_member(gid) then
    raise exception 'Групу не знайдено';
  end if;
  if archived and not private.group_settled(gid) then
    raise exception 'В архів можна перенести лише групу, де всі розрахувалися';
  end if;
  update public.group_members
  set archived_at = case when set_group_archived.archived then now() end
  where group_id = gid and user_id = auth.uid();
end;
$$;

revoke execute on function
  private.group_settled(bigint),
  public.group_list(),
  public.set_group_archived(bigint, boolean)
from public, anon, authenticated;
grant execute on function
  private.group_settled(bigint),
  public.group_list(),
  public.set_group_archived(bigint, boolean)
to authenticated;
