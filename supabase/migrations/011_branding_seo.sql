-- Брендинг і SEO, які налаштовує адміністратор:
-- • логотип (показується зліва вгорі замість назви, пропорція 2:1);
-- • назва й опис сайту та картинка-прев'ю для соцмереж (Open Graph).
-- Файли лежать у публічному сховищі branding. Скрипт можна виконувати повторно.

alter table public.app_settings add column if not exists logo_path text;
alter table public.app_settings add column if not exists og_image_path text;
alter table public.app_settings add column if not exists site_title text not null
  default 'Спільні витрати — рахуйте витрати з друзями без сварок';
alter table public.app_settings add column if not exists site_description text not null
  default 'Додавайте спільні витрати в поїздках, квартирі чи на вечірках — застосунок сам порахує, хто кому скільки винен. Фото чеків, різні валюти, запрошення за посиланням.';
alter table public.app_settings drop constraint if exists app_settings_site_check;
alter table public.app_settings add constraint app_settings_site_check check (
  char_length(site_title) between 1 and 120
  and char_length(site_description) between 1 and 300
  and (logo_path is null or (char_length(logo_path) <= 200 and logo_path !~ '\.\.'))
  and (og_image_path is null or (char_length(og_image_path) <= 200 and og_image_path !~ '\.\.'))
);

-- Сховище для логотипу й картинки-прев'ю: бачать усі (посилання публічні), змінює лише адмін.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('branding', 'branding', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "branding: адмін бачить" on storage.objects;
create policy "branding: адмін бачить" on storage.objects
  for select to authenticated using (bucket_id = 'branding' and private.is_admin());
drop policy if exists "branding: адмін завантажує" on storage.objects;
create policy "branding: адмін завантажує" on storage.objects
  for insert to authenticated with check (bucket_id = 'branding' and private.is_admin());
drop policy if exists "branding: адмін видаляє" on storage.objects;
create policy "branding: адмін видаляє" on storage.objects
  for delete to authenticated using (bucket_id = 'branding' and private.is_admin());

-- Зберегти брендинг і SEO. Повертає старі шляхи файлів, щоб застосунок видалив непотрібні.
create or replace function public.admin_set_branding(
  site_title text, site_description text, logo_path text, og_image_path text
)
returns table (old_logo_path text, old_og_image_path text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  old_logo text;
  old_og text;
begin
  if not private.is_admin() then
    raise exception 'Лише для адміністратора';
  end if;
  if char_length(trim(coalesce(admin_set_branding.site_title, ''))) not between 1 and 120 then
    raise exception 'Назва сайту — від 1 до 120 символів';
  end if;
  if char_length(trim(coalesce(admin_set_branding.site_description, ''))) not between 1 and 300 then
    raise exception 'Опис — від 1 до 300 символів';
  end if;
  select s.logo_path, s.og_image_path into old_logo, old_og from public.app_settings s where s.id;
  update public.app_settings s set
    site_title = trim(admin_set_branding.site_title),
    site_description = trim(admin_set_branding.site_description),
    logo_path = admin_set_branding.logo_path,
    og_image_path = admin_set_branding.og_image_path
  where s.id;
  return query select
    case when old_logo is distinct from admin_set_branding.logo_path then old_logo end,
    case when old_og is distinct from admin_set_branding.og_image_path then old_og end;
end;
$$;

-- Публічні дані сайту (назва, опис, логотип, прев'ю) — для сторінки входу й для прев'ю в соцмережах.
create or replace function public.site_meta()
returns table (site_title text, site_description text, logo_path text, og_image_path text, design text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.site_title, s.site_description, s.logo_path, s.og_image_path, s.design from public.app_settings s where s.id;
$$;

revoke execute on function
  public.admin_set_branding(text, text, text, text),
  public.site_meta()
from public, anon, authenticated;
grant execute on function public.admin_set_branding(text, text, text, text) to authenticated;
grant execute on function public.site_meta() to anon, authenticated;
