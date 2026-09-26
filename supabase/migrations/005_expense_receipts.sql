-- Фото квитанцій до витрат.
-- Файли лежать у приватному сховищі receipts у папці групи: «<id групи>/<файл>.jpg».
-- Бачити, додавати й видаляти їх можуть лише учасники цієї групи.
-- Скрипт можна виконувати повторно.

alter table public.expenses add column if not exists receipt_path text;
alter table public.expenses drop constraint if exists expenses_receipt_path_check;
alter table public.expenses add constraint expenses_receipt_path_check
  check (receipt_path is null or (receipt_path like group_id::text || '/%' and char_length(receipt_path) <= 200));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Чи належить файл зі сховища receipts групі, де є поточний користувач.
create or replace function private.can_access_receipt(object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  folder text := (storage.foldername(object_name))[1];
begin
  if folder is null or folder !~ '^[0-9]{1,18}$' then
    return false;
  end if;
  return private.is_group_member(folder::bigint);
end;
$$;

drop policy if exists "receipts: учасники групи бачать" on storage.objects;
create policy "receipts: учасники групи бачать" on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts' and private.can_access_receipt(name));

drop policy if exists "receipts: учасники групи завантажують" on storage.objects;
create policy "receipts: учасники групи завантажують" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'receipts' and private.can_access_receipt(name));

drop policy if exists "receipts: учасники групи видаляють" on storage.objects;
create policy "receipts: учасники групи видаляють" on storage.objects
  for delete to authenticated
  using (bucket_id = 'receipts' and private.can_access_receipt(name));

-- Прикріпити (або прибрати, якщо null) фото квитанції до витрати. Повертає попередній шлях,
-- щоб застосунок міг видалити старий файл.
create or replace function public.set_expense_receipt(expense_id bigint, receipt_path text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  gid bigint;
  old_path text;
begin
  select e.group_id, e.receipt_path into gid, old_path
  from public.expenses e where e.id = set_expense_receipt.expense_id;
  if gid is null or not private.is_group_member(gid) then
    raise exception 'Витрату не знайдено';
  end if;
  if receipt_path is not null and (receipt_path not like gid::text || '/%' or receipt_path like '%..%') then
    raise exception 'Некоректний файл квитанції';
  end if;
  update public.expenses e set receipt_path = set_expense_receipt.receipt_path
  where e.id = set_expense_receipt.expense_id;
  return old_path;
end;
$$;

revoke execute on function
  private.can_access_receipt(text),
  public.set_expense_receipt(bigint, text)
from public, anon, authenticated;
grant execute on function
  private.can_access_receipt(text),
  public.set_expense_receipt(bigint, text)
to authenticated;
