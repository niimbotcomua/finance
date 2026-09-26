-- Валюти.
-- • Довідник валют із прапорцями (public.currencies).
-- • Основна валюта групи обирається під час створення (groups.currency) — у ній рахуються баланси.
-- • Курси інших валют до основної — налаштування групи (public.group_rates): «1 USD = 41,25 ₴».
-- • Витрату можна внести в іншій валюті: зберігаємо її суму та курс, а в amount і частках — суму в основній валюті.
--   Тому баланси, борги й аналітика рахуються як і раніше, а зміна курсу не переписує старі витрати.
-- Суми — у сотих частках валюти (копійки, центи). Скрипт можна виконувати повторно.

-- ---------- Довідник валют ----------

create table if not exists public.currencies (
  code       text primary key check (code ~ '^[A-Z]{3}$'),
  name       text not null,
  flag       text not null,
  sort_order int not null default 0
);

insert into public.currencies (code, name, flag, sort_order) values
  ('UAH', 'гривня', '🇺🇦', 1),
  ('USD', 'долар США', '🇺🇸', 2),
  ('EUR', 'євро', '🇪🇺', 3),
  ('PLN', 'польський злотий', '🇵🇱', 4),
  ('GBP', 'фунт стерлінгів', '🇬🇧', 5),
  ('CHF', 'швейцарський франк', '🇨🇭', 6),
  ('CZK', 'чеська крона', '🇨🇿', 7),
  ('HUF', 'угорський форинт', '🇭🇺', 8),
  ('RON', 'румунський лей', '🇷🇴', 9),
  ('BGN', 'болгарський лев', '🇧🇬', 10),
  ('MDL', 'молдовський лей', '🇲🇩', 11),
  ('GEL', 'грузинський ларі', '🇬🇪', 12),
  ('TRY', 'турецька ліра', '🇹🇷', 13),
  ('SEK', 'шведська крона', '🇸🇪', 14),
  ('NOK', 'норвезька крона', '🇳🇴', 15),
  ('DKK', 'данська крона', '🇩🇰', 16),
  ('CAD', 'канадський долар', '🇨🇦', 17),
  ('AUD', 'австралійський долар', '🇦🇺', 18),
  ('CNY', 'китайський юань', '🇨🇳', 19),
  ('AED', 'дирхам ОАЕ', '🇦🇪', 20),
  ('EGP', 'єгипетський фунт', '🇪🇬', 21),
  ('THB', 'тайський бат', '🇹🇭', 22),
  ('ILS', 'ізраїльський шекель', '🇮🇱', 23),
  ('KZT', 'казахстанський тенге', '🇰🇿', 24)
on conflict (code) do update set name = excluded.name, flag = excluded.flag, sort_order = excluded.sort_order;

alter table public.currencies enable row level security;
drop policy if exists "currencies: бачать усі" on public.currencies;
create policy "currencies: бачать усі" on public.currencies for select to authenticated using (true);
revoke all on public.currencies from anon, authenticated;
grant select on public.currencies to authenticated;

-- Основна валюта групи — лише з довідника.
alter table public.groups drop constraint if exists groups_currency_fkey;
alter table public.groups add constraint groups_currency_fkey foreign key (currency) references public.currencies (code);

-- ---------- Курси групи ----------

create table if not exists public.group_rates (
  group_id   bigint not null references public.groups (id) on delete cascade,
  currency   text not null references public.currencies (code),
  rate       numeric(20, 8) not null check (rate > 0 and rate < 1000000),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (group_id, currency)
);

alter table public.group_rates enable row level security;
drop policy if exists "group_rates: учасники бачать" on public.group_rates;
create policy "group_rates: учасники бачать" on public.group_rates
  for select to authenticated using (private.is_group_member(group_id));
revoke all on public.group_rates from anon, authenticated;
grant select on public.group_rates to authenticated;

-- Задати курс (1 одиниця валюти = rate основної валюти) або прибрати його (rate = null).
create or replace function public.set_group_rate(gid bigint, currency text, rate numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  base text;
begin
  select g.currency into base from public.groups g where g.id = gid;
  if base is null or not private.is_group_member(gid) then
    raise exception 'Групу не знайдено';
  end if;
  if set_group_rate.currency = base then
    raise exception 'Це основна валюта групи';
  end if;
  if set_group_rate.rate is null then
    delete from public.group_rates r where r.group_id = gid and r.currency = set_group_rate.currency;
    return;
  end if;
  if not exists (select 1 from public.currencies c where c.code = set_group_rate.currency) then
    raise exception 'Невідома валюта';
  end if;
  if set_group_rate.rate <= 0 or set_group_rate.rate >= 1000000 then
    raise exception 'Некоректний курс';
  end if;
  insert into public.group_rates (group_id, currency, rate, updated_by)
  values (gid, set_group_rate.currency, set_group_rate.rate, auth.uid())
  on conflict (group_id, currency) do update
    set rate = excluded.rate, updated_by = excluded.updated_by, updated_at = now();
end;
$$;

-- ---------- Створення групи з валютою ----------

drop function if exists public.create_group(text);
create or replace function public.create_group(group_name text, group_currency text default 'UAH')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id bigint;
begin
  if auth.uid() is null then
    raise exception 'Потрібно увійти';
  end if;
  if not exists (select 1 from public.currencies c where c.code = coalesce(group_currency, 'UAH')) then
    raise exception 'Невідома валюта';
  end if;
  insert into public.groups (name, currency, created_by)
  values (trim(group_name), coalesce(group_currency, 'UAH'), auth.uid())
  returning id into new_id;
  insert into public.group_members (group_id, user_id) values (new_id, auth.uid());
  return new_id;
end;
$$;

-- ---------- Витрати в іншій валюті ----------

alter table public.expenses add column if not exists currency text references public.currencies (code);
alter table public.expenses add column if not exists original_amount bigint;
alter table public.expenses add column if not exists rate numeric(20, 8);
alter table public.expenses drop constraint if exists expenses_currency_check;
alter table public.expenses add constraint expenses_currency_check check (
  (currency is null and original_amount is null and rate is null)
  or (currency is not null and original_amount > 0 and original_amount <= 100000000000 and rate > 0)
);

-- Знімок для історії — тепер і з валютою.
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
    'shares', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'amount', s.amount) order by s.user_id)
      from public.expense_shares s where s.expense_id = e.id
    ), '[]'::jsonb)
  )
  from public.expenses e
  where e.id = eid;
$$;

-- Перевіряє валюту витрати й повертає курс, за яким її перераховано (null — основна валюта).
-- keep_rate — курс, збережений у витраті раніше: під час редагування в тій самій валюті він не змінюється.
create or replace function private.expense_rate(
  gid bigint, amount bigint, expense_currency text, original_amount bigint, keep_rate numeric
)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  base text;
  used numeric;
begin
  select g.currency into base from public.groups g where g.id = gid;
  if expense_currency is null or expense_currency = base then
    return null;
  end if;
  if original_amount is null or original_amount <= 0 or original_amount > 100000000000 then
    raise exception 'Некоректна сума у валюті';
  end if;
  used := coalesce(keep_rate, (select r.rate from public.group_rates r where r.group_id = gid and r.currency = expense_currency));
  if used is null then
    raise exception 'Для валюти % не задано курс у налаштуваннях групи', expense_currency;
  end if;
  -- Допускаємо копійку різниці через округлення в браузері.
  if abs(amount - round(original_amount * used)) > 1 then
    raise exception 'Курс валюти змінився — оновіть сторінку й спробуйте ще раз';
  end if;
  return used;
end;
$$;

drop function if exists public.add_expense(bigint, text, bigint, uuid, jsonb, date, bigint);
create or replace function public.add_expense(
  gid bigint,
  description text,
  amount bigint,
  paid_by uuid,
  shares jsonb,
  expense_date date default current_date,
  category_id bigint default null,
  expense_currency text default null,
  original_amount bigint default null
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
                               currency, original_amount, rate)
  values (gid, trim(add_expense.description), add_expense.amount, add_expense.paid_by, auth.uid(),
          coalesce(expense_date, current_date), add_expense.category_id,
          case when used_rate is not null then expense_currency end,
          case when used_rate is not null then add_expense.original_amount end,
          used_rate)
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

drop function if exists public.update_expense(bigint, text, bigint, uuid, jsonb, date, bigint);
create or replace function public.update_expense(
  expense_id bigint,
  description text,
  amount bigint,
  paid_by uuid,
  shares jsonb,
  expense_date date,
  category_id bigint default null,
  expense_currency text default null,
  original_amount bigint default null
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
    rate = used_rate
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

-- ---------- Права на функції ----------

revoke execute on function
  public.set_group_rate(bigint, text, numeric),
  public.create_group(text, text),
  private.expense_rate(bigint, bigint, text, bigint, numeric),
  public.add_expense(bigint, text, bigint, uuid, jsonb, date, bigint, text, bigint),
  public.update_expense(bigint, text, bigint, uuid, jsonb, date, bigint, text, bigint)
from public, anon, authenticated;
grant execute on function
  public.set_group_rate(bigint, text, numeric),
  public.create_group(text, text),
  public.add_expense(bigint, text, bigint, uuid, jsonb, date, bigint, text, bigint),
  public.update_expense(bigint, text, bigint, uuid, jsonb, date, bigint, text, bigint)
to authenticated;
