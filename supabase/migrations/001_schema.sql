-- Початкова схема бази даних для застосунку «Спільні витрати».
-- Наступні зміни — у файлах 002_*.sql і далі; виконуйте їх по черзі.
-- Усі суми зберігаються в копійках (цілі числа).

-- ---------- Таблиці ----------

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  name       text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_email_key on public.profiles (lower(email));

create table if not exists public.groups (
  id         bigint generated always as identity primary key,
  name       text not null check (char_length(name) between 1 and 100),
  currency   text not null default 'UAH',
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  id        bigint generated always as identity primary key,
  group_id  bigint not null references public.groups (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  unique (group_id, user_id)
);
create index if not exists group_members_user_idx on public.group_members (user_id);

create table if not exists public.expenses (
  id          bigint generated always as identity primary key,
  group_id    bigint not null references public.groups (id) on delete cascade,
  description text not null check (char_length(description) between 1 and 200),
  amount      bigint not null check (amount > 0 and amount <= 100000000000),
  paid_by     uuid not null references public.profiles (id),
  created_by  uuid not null references public.profiles (id),
  date        date not null default current_date,
  created_at  timestamptz not null default now()
);
create index if not exists expenses_group_idx on public.expenses (group_id);

create table if not exists public.expense_shares (
  expense_id bigint not null references public.expenses (id) on delete cascade,
  user_id    uuid not null references public.profiles (id),
  amount     bigint not null check (amount >= 0),
  primary key (expense_id, user_id)
);

create table if not exists public.settlements (
  id         bigint generated always as identity primary key,
  group_id   bigint not null references public.groups (id) on delete cascade,
  from_user  uuid not null references public.profiles (id),
  to_user    uuid not null references public.profiles (id),
  amount     bigint not null check (amount > 0 and amount <= 100000000000),
  date       date not null default current_date,
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  check (from_user <> to_user)
);
create index if not exists settlements_group_idx on public.settlements (group_id);

-- ---------- Профіль створюється автоматично під час реєстрації ----------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    new.email,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Допоміжні функції для правил доступу ----------
-- Лежать у схемі private, яку Supabase не відкриває через API: їх не можна викликати напряму.

create schema if not exists private;
grant usage on schema private to authenticated;

-- security definer, щоб правила group_members не викликали самі себе рекурсивно.
create or replace function private.is_group_member(gid bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.group_members
    where group_id = gid and user_id = auth.uid()
  );
$$;

create or replace function private.shares_group_with(other uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_members a
    join public.group_members b on a.group_id = b.group_id
    where a.user_id = auth.uid() and b.user_id = other
  );
$$;

-- ---------- Row Level Security: кожен бачить лише свої групи ----------

alter table public.profiles       enable row level security;
alter table public.groups         enable row level security;
alter table public.group_members  enable row level security;
alter table public.expenses       enable row level security;
alter table public.expense_shares enable row level security;
alter table public.settlements    enable row level security;

drop policy if exists "profiles: свій і співучасників" on public.profiles;
create policy "profiles: свій і співучасників" on public.profiles
  for select to authenticated
  using (id = auth.uid() or private.shares_group_with(id));

drop policy if exists "profiles: змінювати свій" on public.profiles;
create policy "profiles: змінювати свій" on public.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "groups: учасники бачать" on public.groups;
create policy "groups: учасники бачать" on public.groups
  for select to authenticated
  using (private.is_group_member(id));

drop policy if exists "groups: учасники перейменовують" on public.groups;
create policy "groups: учасники перейменовують" on public.groups
  for update to authenticated
  using (private.is_group_member(id)) with check (private.is_group_member(id));

drop policy if exists "group_members: учасники бачать" on public.group_members;
create policy "group_members: учасники бачать" on public.group_members
  for select to authenticated
  using (private.is_group_member(group_id));

drop policy if exists "expenses: учасники бачать" on public.expenses;
create policy "expenses: учасники бачать" on public.expenses
  for select to authenticated
  using (private.is_group_member(group_id));

drop policy if exists "expenses: учасники видаляють" on public.expenses;
create policy "expenses: учасники видаляють" on public.expenses
  for delete to authenticated
  using (private.is_group_member(group_id));

drop policy if exists "expense_shares: учасники бачать" on public.expense_shares;
create policy "expense_shares: учасники бачать" on public.expense_shares
  for select to authenticated
  using (exists (
    select 1 from public.expenses e
    where e.id = expense_id and private.is_group_member(e.group_id)
  ));

drop policy if exists "settlements: учасники бачать" on public.settlements;
create policy "settlements: учасники бачать" on public.settlements
  for select to authenticated
  using (private.is_group_member(group_id));

drop policy if exists "settlements: учасники додають" on public.settlements;
create policy "settlements: учасники додають" on public.settlements
  for insert to authenticated
  with check (
    private.is_group_member(group_id)
    and created_by = auth.uid()
    and exists (select 1 from public.group_members where group_id = settlements.group_id and user_id = from_user)
    and exists (select 1 from public.group_members where group_id = settlements.group_id and user_id = to_user)
  );

drop policy if exists "settlements: учасники видаляють" on public.settlements;
create policy "settlements: учасники видаляють" on public.settlements
  for delete to authenticated
  using (private.is_group_member(group_id));

-- ---------- Дії, що потребують перевірок (викликаються через supabase.rpc) ----------

create or replace function public.create_group(group_name text)
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
  insert into public.groups (name, created_by) values (trim(group_name), auth.uid()) returning id into new_id;
  insert into public.group_members (group_id, user_id) values (new_id, auth.uid());
  return new_id;
end;
$$;

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
    raise exception 'Користувача з таким email не знайдено. Попросіть його спершу зареєструватися.';
  end if;
  if exists (select 1 from public.group_members where group_id = gid and user_id = new_member) then
    raise exception 'Користувач уже є учасником групи';
  end if;
  insert into public.group_members (group_id, user_id) values (gid, new_member);
  return new_member;
end;
$$;

create or replace function public.remove_group_member(gid bigint, member uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_group_member(gid) then
    raise exception 'Групу не знайдено';
  end if;
  if exists (select 1 from public.expenses where group_id = gid and paid_by = member)
     or exists (select 1 from public.expense_shares s join public.expenses e on e.id = s.expense_id
                where e.group_id = gid and s.user_id = member)
     or exists (select 1 from public.settlements where group_id = gid and member in (from_user, to_user)) then
    raise exception 'Учасник має історію витрат у групі, його не можна видалити';
  end if;
  delete from public.group_members where group_id = gid and user_id = member;
end;
$$;

-- shares: [{"user_id": "...", "amount": 1234}, ...] — сума часток має дорівнювати amount.
create or replace function public.add_expense(
  gid bigint,
  description text,
  amount bigint,
  paid_by uuid,
  shares jsonb,
  expense_date date default current_date
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id bigint;
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

  insert into public.expenses (group_id, description, amount, paid_by, created_by, date)
  values (gid, trim(add_expense.description), add_expense.amount, add_expense.paid_by, auth.uid(),
          coalesce(expense_date, current_date))
  returning id into new_id;

  insert into public.expense_shares (expense_id, user_id, amount)
  select new_id, (s ->> 'user_id')::uuid, (s ->> 'amount')::bigint
  from jsonb_array_elements(shares) s
  where (s ->> 'amount')::bigint > 0;

  return new_id;
end;
$$;

-- Список моїх груп із моїм балансом (додатний — мені винні).
create or replace function public.my_groups()
returns table (id bigint, name text, currency text, member_count bigint, my_balance bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select
    g.id, g.name, g.currency,
    (select count(*) from public.group_members where group_id = g.id),
    (
      coalesce((select sum(e.amount) from public.expenses e where e.group_id = g.id and e.paid_by = auth.uid()), 0)
      - coalesce((select sum(s.amount) from public.expense_shares s join public.expenses e on e.id = s.expense_id
                  where e.group_id = g.id and s.user_id = auth.uid()), 0)
      + coalesce((select sum(t.amount) from public.settlements t where t.group_id = g.id and t.from_user = auth.uid()), 0)
      - coalesce((select sum(t.amount) from public.settlements t where t.group_id = g.id and t.to_user = auth.uid()), 0)
    )::bigint
  from public.groups g
  join public.group_members m on m.group_id = g.id and m.user_id = auth.uid()
  order by g.created_at desc, g.id desc;
$$;

-- ---------- Права доступу ----------

-- Supabase за замовчуванням дає ролям anon/authenticated усі права на нові таблиці — звужуємо їх.
revoke all on public.profiles, public.groups, public.group_members, public.expenses,
  public.expense_shares, public.settlements from anon, authenticated;
grant select, update (name) on public.profiles to authenticated;
grant select, update (name) on public.groups to authenticated;
grant select on public.group_members to authenticated;
grant select, delete on public.expenses to authenticated;
grant select on public.expense_shares to authenticated;
grant select, insert, delete on public.settlements to authenticated;

revoke execute on all functions in schema public, private from public, anon, authenticated;
grant execute on function
  private.is_group_member(bigint),
  private.shares_group_with(uuid),
  public.create_group(text),
  public.add_group_member(bigint, text),
  public.remove_group_member(bigint, uuid),
  public.add_expense(bigint, text, bigint, uuid, jsonb, date),
  public.my_groups()
to authenticated;
