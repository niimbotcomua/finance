-- Налаштування застосунку, які змінює адміністратор.
-- Поки що одне: валюта за замовчуванням для нових груп.
-- Скрипт можна виконувати повторно.

create table if not exists public.app_settings (
  id               boolean primary key default true check (id), -- рівно один рядок
  default_currency text not null default 'UAH' references public.currencies (code)
);
insert into public.app_settings (id) values (true) on conflict (id) do nothing;

alter table public.app_settings enable row level security;
drop policy if exists "app_settings: бачать усі" on public.app_settings;
create policy "app_settings: бачать усі" on public.app_settings for select to authenticated using (true);
revoke all on public.app_settings from anon, authenticated;
grant select on public.app_settings to authenticated;

create or replace function public.admin_set_default_currency(currency text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Лише для адміністратора';
  end if;
  if not exists (select 1 from public.currencies c where c.code = admin_set_default_currency.currency) then
    raise exception 'Невідома валюта';
  end if;
  update public.app_settings set default_currency = admin_set_default_currency.currency where id;
end;
$$;

revoke execute on function public.admin_set_default_currency(text) from public, anon, authenticated;
grant execute on function public.admin_set_default_currency(text) to authenticated;
