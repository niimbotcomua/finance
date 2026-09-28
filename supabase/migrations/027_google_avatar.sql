-- Фото з Google-акаунта як аватарка: під час реєстрації через Google (або першого входу через Google
-- в уже наявний акаунт) беремо фото з профілю Google. Власне фото, завантажене в застосунку, його замінює;
-- «Видалити фото» прибирає і його. Скрипт можна виконувати повторно.

alter table public.profiles add column if not exists photo_url text;
alter table public.profiles drop constraint if exists profiles_photo_url_check;
alter table public.profiles add constraint profiles_photo_url_check
  check (photo_url is null or (photo_url like 'https://%' and char_length(photo_url) <= 1000));

-- Фото з метаданих входу (Google кладе його в avatar_url і picture).
create or replace function private.meta_photo(meta jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p like 'https://%' and char_length(p) <= 1000 then p end
  from (select coalesce(nullif(trim(meta ->> 'avatar_url'), ''), nullif(trim(meta ->> 'picture'), '')) as p) s;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, name, photo_url)
  values (
    new.id,
    new.email,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1)),
    private.meta_photo(new.raw_user_meta_data)
  );
  return new;
end;
$$;

-- Уперше увійшов через Google в акаунт, створений поштою: підставляємо фото, якщо свого ще немає.
create or replace function private.google_photo_on_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.meta_photo(old.raw_user_meta_data) is null and private.meta_photo(new.raw_user_meta_data) is not null then
    update public.profiles p set photo_url = private.meta_photo(new.raw_user_meta_data)
     where p.id = new.id and p.avatar_path is null and p.photo_url is null;
  end if;
  return null;
end;
$$;

drop trigger if exists google_photo_on_link on auth.users;
create trigger google_photo_on_link
  after update of raw_user_meta_data on auth.users
  for each row execute function private.google_photo_on_link();

-- Користувач сам змінив або видалив фото в застосунку — фото з Google більше не показуємо.
create or replace function private.drop_google_photo()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.photo_url := null;
  return new;
end;
$$;

drop trigger if exists drop_google_photo on public.profiles;
create trigger drop_google_photo
  before update of avatar_path on public.profiles
  for each row execute function private.drop_google_photo();

-- Уже наявні акаунти без фото: беремо фото з Google, якщо воно є.
update public.profiles p set photo_url = private.meta_photo(u.raw_user_meta_data)
  from auth.users u
 where u.id = p.id and p.avatar_path is null and p.photo_url is null
   and private.meta_photo(u.raw_user_meta_data) is not null;

-- Список користувачів для адміна: без власного фото показуємо фото з Google (тип результату той самий).
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
      p.id, p.name, p.email, coalesce(p.avatar_path, p.photo_url), p.created_at,
      (select count(*) from public.group_members m where m.user_id = p.id),
      (select count(*) from public.expenses e where e.created_by = p.id),
      exists (select 1 from private.admins a where a.user_id = p.id)
    from public.profiles p
    order by p.created_at desc;
end;
$$;
