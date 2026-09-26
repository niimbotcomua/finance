-- Окремий логотип для кожного дизайну (dark, mono, nova).
-- Логотипи зберігаються в app_settings.design_logos: {"dark": "logo-….png", "mono": …, "nova": …}.
-- Спільний логотип (logo_path), якщо був, переноситься в усі три дизайни.
-- Скрипт можна виконувати повторно.

alter table public.app_settings add column if not exists design_logos jsonb not null default '{}'::jsonb;
alter table public.app_settings drop constraint if exists app_settings_design_logos_check;
alter table public.app_settings add constraint app_settings_design_logos_check check (
  jsonb_typeof(design_logos) = 'object'
  and not (design_logos - array['dark', 'mono', 'nova'] <> '{}'::jsonb)
);

update public.app_settings
set design_logos = jsonb_build_object('dark', logo_path, 'mono', logo_path, 'nova', logo_path),
    logo_path = null
where id and logo_path is not null and design_logos = '{}'::jsonb;

-- Задати (або прибрати, якщо null) логотип дизайну. Повертає старий файл, якщо він більше ніде не використовується,
-- щоб застосунок видалив його зі сховища.
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
  if admin_set_design_logo.design not in ('dark', 'mono', 'nova') then
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

-- Логотипи дизайнів — публічні (потрібні й на сторінці входу).
create or replace function public.site_logos()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select s.design_logos from public.app_settings s where s.id;
$$;

revoke execute on function public.admin_set_design_logo(text, text), public.site_logos() from public, anon, authenticated;
grant execute on function public.admin_set_design_logo(text, text) to authenticated;
grant execute on function public.site_logos() to anon, authenticated;
