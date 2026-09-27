-- Четвертий дизайн: paper — спокійний «паперовий» (тепло-сірий фон, білі картки з рамкою, теракотовий акцент).
-- Скрипт можна виконувати повторно.

alter table public.app_settings drop constraint if exists app_settings_design_check;
alter table public.app_settings add constraint app_settings_design_check check (design in ('dark', 'mono', 'nova', 'paper'));

alter table public.app_settings drop constraint if exists app_settings_design_logos_check;
alter table public.app_settings add constraint app_settings_design_logos_check check (
  jsonb_typeof(design_logos) = 'object'
  and not (design_logos - array['dark', 'mono', 'nova', 'paper'] <> '{}'::jsonb)
);

alter table public.profiles drop constraint if exists profiles_design_check;
alter table public.profiles add constraint profiles_design_check check (design is null or design in ('dark', 'mono', 'nova', 'paper'));

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
  if admin_set_design.design not in ('dark', 'mono', 'nova', 'paper') then
    raise exception 'Невідомий дизайн';
  end if;
  update public.app_settings set design = admin_set_design.design where id;
end;
$$;

create or replace function public.admin_set_design_logo(design text, logo_path text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  settings public.app_settings;
  old_path text;
begin
  if not private.is_admin() then
    raise exception 'Лише для адміністратора';
  end if;
  if admin_set_design_logo.design not in ('dark', 'mono', 'nova', 'paper') then
    raise exception 'Невідомий дизайн';
  end if;
  if admin_set_design_logo.logo_path is not null
     and (char_length(admin_set_design_logo.logo_path) > 200 or admin_set_design_logo.logo_path ~ '\.\.') then
    raise exception 'Некоректний файл логотипу';
  end if;
  select * into settings from public.app_settings s where s.id;
  old_path := settings.design_logos ->> admin_set_design_logo.design;

  update public.app_settings s set design_logos = case
    when admin_set_design_logo.logo_path is null then s.design_logos - admin_set_design_logo.design
    else s.design_logos || jsonb_build_object(admin_set_design_logo.design, admin_set_design_logo.logo_path)
  end
  where s.id
  returning * into settings;

  -- Той самий файл може бути логотипом іншого дизайну — тоді не видаляємо.
  if old_path is null
     or old_path = admin_set_design_logo.logo_path
     or exists (select 1 from jsonb_each_text(settings.design_logos) l where l.value = old_path)
     or old_path = settings.logo_path
     or old_path = settings.og_image_path then
    return null;
  end if;
  return old_path;
end;
$$;
