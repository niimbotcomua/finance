-- Власний вибір дизайну кожного користувача (null — як обрав адміністратор для всіх).
-- Скрипт можна виконувати повторно.

alter table public.profiles add column if not exists design text;
alter table public.profiles drop constraint if exists profiles_design_check;
alter table public.profiles add constraint profiles_design_check check (design is null or design in ('dark', 'mono', 'nova'));

-- Змінювати можна лише своє (політика «profiles: змінювати свій» уже діє) і лише ці колонки.
grant update (name, avatar_path, design) on public.profiles to authenticated;
