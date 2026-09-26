-- Аватари, перейменування групи автором, теги (категорії) витрат і супер-адмін.
-- Скрипт можна виконувати повторно.

-- ---------- Супер-адміни ----------
-- Таблиця в схемі private: через API її не видно й не змінити.
-- Першого адміна призначають вручну в SQL Editor:
--   insert into private.admins (user_id) select id from public.profiles where email = '…';

create table if not exists private.admins (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);
revoke all on private.admins from public, anon, authenticated;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.admins where user_id = auth.uid());
$$;

create or replace function public.am_i_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_admin();
$$;

-- Усі користувачі системи — лише для адміна.
create or replace function public.admin_users()
returns table (
  id uuid, name text, email text, avatar_path text, created_at timestamptz,
  group_count bigint, expense_count bigint, is_admin boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Лише для адміністратора';
  end if;
  return query
    select
      p.id, p.name, p.email, p.avatar_path, p.created_at,
      (select count(*) from public.group_members m where m.user_id = p.id),
      (select count(*) from public.expenses e where e.created_by = p.id),
      exists (select 1 from private.admins a where a.user_id = p.id)
    from public.profiles p
    order by p.created_at desc;
end;
$$;

create or replace function public.admin_set_admin(target uuid, make_admin boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Лише для адміністратора';
  end if;
  if make_admin then
    insert into private.admins (user_id) values (target) on conflict do nothing;
  else
    if target = auth.uid() then
      raise exception 'Не можна зняти права адміністратора із себе';
    end if;
    delete from private.admins where user_id = target;
  end if;
end;
$$;

-- ---------- Аватар ----------
-- Зберігаємо шлях до файлу в сховищі (а не довільну адресу): лише у власній папці користувача.

alter table public.profiles add column if not exists avatar_path text;
alter table public.profiles drop constraint if exists profiles_avatar_path_check;
alter table public.profiles add constraint profiles_avatar_path_check
  check (avatar_path is null or (avatar_path like id::text || '/%' and char_length(avatar_path) <= 200));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Файли видно всім за прямим посиланням (кошик публічний); керувати — лише своєю папкою.
drop policy if exists "avatars: свої файли бачить" on storage.objects;
create policy "avatars: свої файли бачить" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars: завантажити у свою папку" on storage.objects;
create policy "avatars: завантажити у свою папку" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars: видалити своє" on storage.objects;
create policy "avatars: видалити своє" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

grant update (name, avatar_path) on public.profiles to authenticated;

-- ---------- Назву групи змінює лише автор ----------

drop policy if exists "groups: учасники перейменовують" on public.groups;
drop policy if exists "groups: автор перейменовує" on public.groups;
create policy "groups: автор перейменовує" on public.groups
  for update to authenticated
  using (created_by = auth.uid() and private.is_group_member(id))
  with check (created_by = auth.uid() and private.is_group_member(id));

-- ---------- Теги (категорії) витрат — спільні для всіх, керує адмін ----------

create table if not exists public.categories (
  id         bigint generated always as identity primary key,
  name       text not null check (char_length(name) between 1 and 40),
  icon       text not null default '' check (char_length(icon) <= 8),
  created_at timestamptz not null default now()
);
create unique index if not exists categories_name_key on public.categories (lower(name));

alter table public.categories enable row level security;

drop policy if exists "categories: усі бачать" on public.categories;
create policy "categories: усі бачать" on public.categories
  for select to authenticated using (true);

drop policy if exists "categories: адмін додає" on public.categories;
create policy "categories: адмін додає" on public.categories
  for insert to authenticated with check (private.is_admin());

drop policy if exists "categories: адмін змінює" on public.categories;
create policy "categories: адмін змінює" on public.categories
  for update to authenticated using (private.is_admin()) with check (private.is_admin());

drop policy if exists "categories: адмін видаляє" on public.categories;
create policy "categories: адмін видаляє" on public.categories
  for delete to authenticated using (private.is_admin());

revoke all on public.categories from anon, authenticated;
grant select, delete on public.categories to authenticated;
grant insert (name, icon), update (name, icon) on public.categories to authenticated;

insert into public.categories (name, icon)
select v.name, v.icon
from (values
  ('Продукти', '🛒'), ('Кафе й ресторани', '🍽️'), ('Транспорт', '🚕'), ('Житло', '🏠'),
  ('Комунальні', '💡'), ('Розваги', '🎉'), ('Подорожі', '✈️'), ('Здоров''я', '💊'),
  ('Покупки', '🛍️'), ('Інше', '📦')
) as v (name, icon)
where not exists (select 1 from public.categories);

alter table public.expenses
  add column if not exists category_id bigint references public.categories (id) on delete set null;

-- add_expense з тегом: стару версію (без category_id) замінюємо новою.
drop function if exists public.add_expense(bigint, text, bigint, uuid, jsonb, date);

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
  if add_expense.category_id is not null
     and not exists (select 1 from public.categories c where c.id = add_expense.category_id) then
    raise exception 'Тег не знайдено';
  end if;

  insert into public.expenses (group_id, description, amount, paid_by, created_by, date, category_id)
  values (gid, trim(add_expense.description), add_expense.amount, add_expense.paid_by, auth.uid(),
          coalesce(expense_date, current_date), add_expense.category_id)
  returning id into new_id;

  insert into public.expense_shares (expense_id, user_id, amount)
  select new_id, (s ->> 'user_id')::uuid, (s ->> 'amount')::bigint
  from jsonb_array_elements(shares) s
  where (s ->> 'amount')::bigint > 0;

  return new_id;
end;
$$;

-- ---------- Права на функції ----------

revoke execute on function
  private.is_admin(),
  public.am_i_admin(),
  public.admin_users(),
  public.admin_set_admin(uuid, boolean),
  public.add_expense(bigint, text, bigint, uuid, jsonb, date, bigint)
from public, anon, authenticated;
grant execute on function
  private.is_admin(),
  public.am_i_admin(),
  public.admin_users(),
  public.admin_set_admin(uuid, boolean),
  public.add_expense(bigint, text, bigint, uuid, jsonb, date, bigint)
to authenticated;
