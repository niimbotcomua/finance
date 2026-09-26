-- Версія дизайну застосунку, яку обирає адміністратор (діє для всіх користувачів).
-- dark — темна (початкова), mono — світла в стилі monobank.
-- Скрипт можна виконувати повторно.

alter table public.app_settings add column if not exists design text not null default 'dark';
alter table public.app_settings drop constraint if exists app_settings_design_check;
alter table public.app_settings add constraint app_settings_design_check check (design in ('dark', 'mono'));

create or replace function public.admin_set_design(design text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Лише для адміністратора';
  end if;
  if admin_set_design.design not in ('dark', 'mono') then
    raise exception 'Невідомий дизайн';
  end if;
  update public.app_settings set design = admin_set_design.design where id;
end;
$$;

revoke execute on function public.admin_set_design(text) from public, anon, authenticated;
grant execute on function public.admin_set_design(text) to authenticated;
