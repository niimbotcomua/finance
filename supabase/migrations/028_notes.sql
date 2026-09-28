-- Необов'язковий коментар до витрати (і боргу) та до повернення боргу. Скрипт можна виконувати повторно.

alter table public.expenses add column if not exists note text;
alter table public.expenses drop constraint if exists expenses_note_check;
alter table public.expenses add constraint expenses_note_check check (note is null or char_length(note) <= 500);

alter table public.settlements add column if not exists note text;
alter table public.settlements drop constraint if exists settlements_note_check;
alter table public.settlements add constraint settlements_note_check check (note is null or char_length(note) <= 500);

-- Знімок для історії — тепер і з коментарем.
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
    'currency', e.currency,
    'original_amount', e.original_amount,
    'note', e.note,
    'shares', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'amount', s.amount) order by s.user_id)
      from public.expense_shares s where s.expense_id = e.id
    ), '[]'::jsonb)
  )
  from public.expenses e
  where e.id = eid;
$$;

-- Додавання й редагування витрати — з коментарем (старі версії без нього прибираємо).
drop function if exists public.add_expense(bigint, text, bigint, uuid, jsonb, date, bigint, text, bigint);
create or replace function public.add_expense(
  gid bigint,
  description text,
  amount bigint,
  paid_by uuid,
  shares jsonb,
  expense_date date default current_date,
  category_id bigint default null,
  expense_currency text default null,
  original_amount bigint default null,
  note text default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id bigint;
  used_rate numeric;
begin
  perform private.check_expense(gid, amount, paid_by, shares, category_id);
  used_rate := private.expense_rate(gid, amount, expense_currency, add_expense.original_amount, null);

  insert into public.expenses (group_id, description, amount, paid_by, created_by, date, category_id,
                               currency, original_amount, rate, note)
  values (gid, trim(add_expense.description), add_expense.amount, add_expense.paid_by, auth.uid(),
          coalesce(expense_date, current_date), add_expense.category_id,
          case when used_rate is not null then expense_currency end,
          case when used_rate is not null then add_expense.original_amount end,
          used_rate, nullif(trim(add_expense.note), ''))
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

drop function if exists public.update_expense(bigint, text, bigint, uuid, jsonb, date, bigint, text, bigint);
create or replace function public.update_expense(
  expense_id bigint,
  description text,
  amount bigint,
  paid_by uuid,
  shares jsonb,
  expense_date date,
  category_id bigint default null,
  expense_currency text default null,
  original_amount bigint default null,
  note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  gid bigint;
  old_currency text;
  old_rate numeric;
  used_rate numeric;
  old_snap jsonb;
  new_snap jsonb;
begin
  select e.group_id, e.currency, e.rate into gid, old_currency, old_rate
  from public.expenses e where e.id = update_expense.expense_id;
  if gid is null or not private.is_group_member(gid) then
    raise exception 'Витрату не знайдено';
  end if;
  perform private.check_expense(gid, amount, paid_by, shares, category_id);
  used_rate := private.expense_rate(gid, amount, expense_currency, update_expense.original_amount,
    case when expense_currency = old_currency then old_rate end);
  old_snap := private.expense_snapshot(update_expense.expense_id);

  update public.expenses e set
    description = trim(update_expense.description),
    amount = update_expense.amount,
    paid_by = update_expense.paid_by,
    date = coalesce(expense_date, e.date),
    category_id = update_expense.category_id,
    currency = case when used_rate is not null then expense_currency end,
    original_amount = case when used_rate is not null then update_expense.original_amount end,
    rate = used_rate,
    note = nullif(trim(update_expense.note), '')
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

revoke execute on function
  public.add_expense(bigint, text, bigint, uuid, jsonb, date, bigint, text, bigint, text),
  public.update_expense(bigint, text, bigint, uuid, jsonb, date, bigint, text, bigint, text)
from public, anon, authenticated;
grant execute on function
  public.add_expense(bigint, text, bigint, uuid, jsonb, date, bigint, text, bigint, text),
  public.update_expense(bigint, text, bigint, uuid, jsonb, date, bigint, text, bigint, text)
to authenticated;
