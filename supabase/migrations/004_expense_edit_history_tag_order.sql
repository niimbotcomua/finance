-- Редагування витрат з історією змін і порядок тегів.
-- Скрипт можна виконувати повторно.

-- ---------- Порядок тегів ----------

alter table public.categories add column if not exists sort_order integer not null default 0;
update public.categories set sort_order = id where sort_order = 0;

grant insert (name, icon, sort_order) on public.categories to authenticated;

-- Новий порядок тегів: ids — усі теги в потрібній послідовності.
create or replace function public.admin_reorder_categories(ids bigint[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Лише для адміністратора';
  end if;
  update public.categories c
  set sort_order = t.pos
  from unnest(ids) with ordinality as t (id, pos)
  where c.id = t.id;
end;
$$;

-- ---------- Історія змін витрат ----------
-- Записи додають лише функції та тригери; користувачі можуть тільки читати історію своїх груп.

create table if not exists public.expense_history (
  id         bigint generated always as identity primary key,
  group_id   bigint not null references public.groups (id) on delete cascade,
  expense_id bigint,  -- без зовнішнього ключа: запис про видалення лишається після видалення витрати
  action     text not null check (action in ('created', 'updated', 'deleted')),
  changed_by uuid references public.profiles (id) on delete set null,
  changed_at timestamptz not null default now(),
  old_data   jsonb,
  new_data   jsonb
);
create index if not exists expense_history_group_idx on public.expense_history (group_id, changed_at desc);
create index if not exists expense_history_expense_idx on public.expense_history (expense_id);

alter table public.expense_history enable row level security;

drop policy if exists "expense_history: учасники бачать" on public.expense_history;
create policy "expense_history: учасники бачать" on public.expense_history
  for select to authenticated
  using (private.is_group_member(group_id));

revoke all on public.expense_history from anon, authenticated;
grant select on public.expense_history to authenticated;

-- Знімок витрати разом із частками — для історії.
create or replace function private.expense_snapshot(eid bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'description', e.description,
    'amount', e.amount,
    'paid_by', e.paid_by,
    'date', e.date,
    'category_id', e.category_id,
    'shares', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'amount', s.amount) order by s.user_id)
      from public.expense_shares s where s.expense_id = e.id
    ), '[]'::jsonb)
  )
  from public.expenses e
  where e.id = eid;
$$;

-- Спільні перевірки для додавання й редагування витрати.
create or replace function private.check_expense(
  gid bigint, amount bigint, paid_by uuid, shares jsonb, category_id bigint
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  share_total bigint;
begin
  if not private.is_group_member(gid) then
    raise exception 'Групу не знайдено';
  end if;
  if not exists (select 1 from public.group_members where group_id = gid and user_id = paid_by) then
    raise exception 'Платник не належить до групи';
  end if;
  if jsonb_typeof(shares) <> 'array' or jsonb_array_length(shares) = 0 then
    raise exception 'Вкажіть, між ким розділити витрату';
  end if;
  if exists (
    select 1 from jsonb_array_elements(shares) s
    where not exists (
      select 1 from public.group_members
      where group_id = gid and user_id = (s ->> 'user_id')::uuid
    )
  ) then
    raise exception 'Учасник не належить до групи';
  end if;
  if exists (select 1 from jsonb_array_elements(shares) s where (s ->> 'amount')::bigint < 0) then
    raise exception 'Некоректна частка';
  end if;
  select coalesce(sum((s ->> 'amount')::bigint), 0) into share_total from jsonb_array_elements(shares) s;
  if share_total <> amount then
    raise exception 'Сума часток має дорівнювати сумі витрати';
  end if;
  if category_id is not null and not exists (select 1 from public.categories c where c.id = category_id) then
    raise exception 'Тег не знайдено';
  end if;
end;
$$;

create or replace function public.add_expense(
  gid bigint,
  description text,
  amount bigint,
  paid_by uuid,
  shares jsonb,
  expense_date date default current_date,
  category_id bigint default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id bigint;
begin
  perform private.check_expense(gid, amount, paid_by, shares, category_id);

  insert into public.expenses (group_id, description, amount, paid_by, created_by, date, category_id)
  values (gid, trim(add_expense.description), add_expense.amount, add_expense.paid_by, auth.uid(),
          coalesce(expense_date, current_date), add_expense.category_id)
  returning id into new_id;

  insert into public.expense_shares (expense_id, user_id, amount)
  select new_id, (s ->> 'user_id')::uuid, (s ->> 'amount')::bigint
  from jsonb_array_elements(shares) s
  where (s ->> 'amount')::bigint > 0;

  insert into public.expense_history (group_id, expense_id, action, changed_by, new_data)
  values (gid, new_id, 'created', auth.uid(), private.expense_snapshot(new_id));

  return new_id;
end;
$$;

create or replace function public.update_expense(
  expense_id bigint,
  description text,
  amount bigint,
  paid_by uuid,
  shares jsonb,
  expense_date date,
  category_id bigint default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  gid bigint;
  old_snap jsonb;
  new_snap jsonb;
begin
  select e.group_id into gid from public.expenses e where e.id = update_expense.expense_id;
  if gid is null or not private.is_group_member(gid) then
    raise exception 'Витрату не знайдено';
  end if;
  perform private.check_expense(gid, amount, paid_by, shares, category_id);
  old_snap := private.expense_snapshot(update_expense.expense_id);

  update public.expenses e set
    description = trim(update_expense.description),
    amount = update_expense.amount,
    paid_by = update_expense.paid_by,
    date = coalesce(expense_date, e.date),
    category_id = update_expense.category_id
  where e.id = update_expense.expense_id;

  delete from public.expense_shares s where s.expense_id = update_expense.expense_id;
  insert into public.expense_shares (expense_id, user_id, amount)
  select update_expense.expense_id, (s ->> 'user_id')::uuid, (s ->> 'amount')::bigint
  from jsonb_array_elements(shares) s
  where (s ->> 'amount')::bigint > 0;

  new_snap := private.expense_snapshot(update_expense.expense_id);
  if new_snap is distinct from old_snap then
    insert into public.expense_history (group_id, expense_id, action, changed_by, old_data, new_data)
    values (gid, update_expense.expense_id, 'updated', auth.uid(), old_snap, new_snap);
  end if;
end;
$$;

-- Видалення витрати теж потрапляє в історію (знімок робимо до видалення часток).
create or replace function private.log_expense_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Група видаляється цілком (каскад) — історія зникає разом із нею, писати нічого.
  if not exists (select 1 from public.groups where id = old.group_id) then
    return old;
  end if;
  insert into public.expense_history (group_id, expense_id, action, changed_by, old_data)
  values (old.group_id, old.id, 'deleted', auth.uid(), private.expense_snapshot(old.id));
  return old;
end;
$$;

drop trigger if exists expenses_log_delete on public.expenses;
create trigger expenses_log_delete
  before delete on public.expenses
  for each row execute function private.log_expense_delete();

-- ---------- Права на функції ----------

revoke execute on function
  public.admin_reorder_categories(bigint[]),
  public.update_expense(bigint, text, bigint, uuid, jsonb, date, bigint),
  public.add_expense(bigint, text, bigint, uuid, jsonb, date, bigint),
  private.expense_snapshot(bigint),
  private.check_expense(bigint, bigint, uuid, jsonb, bigint),
  private.log_expense_delete()
from public, anon, authenticated;
grant execute on function
  public.admin_reorder_categories(bigint[]),
  public.update_expense(bigint, text, bigint, uuid, jsonb, date, bigint),
  public.add_expense(bigint, text, bigint, uuid, jsonb, date, bigint)
to authenticated;
