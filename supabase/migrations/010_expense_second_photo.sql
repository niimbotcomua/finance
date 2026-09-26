-- Друге фото до витрати (наприклад, чек і фото товару).
-- Файли лежать там само, у сховищі receipts у папці групи. Скрипт можна виконувати повторно.

alter table public.expenses add column if not exists receipt_path2 text;
alter table public.expenses drop constraint if exists expenses_receipt_path2_check;
alter table public.expenses add constraint expenses_receipt_path2_check
  check (receipt_path2 is null or (receipt_path2 like group_id::text || '/%' and char_length(receipt_path2) <= 200));

-- Прикріпити (або прибрати, якщо null) фото № slot (1 або 2). Повертає попередній шлях,
-- щоб застосунок міг видалити старий файл.
create or replace function public.set_expense_photo(expense_id bigint, slot int, photo_path text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  gid bigint;
  old_path text;
begin
  if slot not in (1, 2) then
    raise exception 'Можна прикріпити не більше 2 фото';
  end if;
  select e.group_id, case when slot = 1 then e.receipt_path else e.receipt_path2 end into gid, old_path
  from public.expenses e where e.id = set_expense_photo.expense_id;
  if gid is null or not private.is_group_member(gid) then
    raise exception 'Витрату не знайдено';
  end if;
  if photo_path is not null and (photo_path not like gid::text || '/%' or photo_path like '%..%') then
    raise exception 'Некоректний файл фото';
  end if;
  if slot = 1 then
    update public.expenses e set receipt_path = photo_path where e.id = set_expense_photo.expense_id;
  else
    update public.expenses e set receipt_path2 = photo_path where e.id = set_expense_photo.expense_id;
  end if;
  return old_path;
end;
$$;

revoke execute on function public.set_expense_photo(bigint, int, text) from public, anon, authenticated;
grant execute on function public.set_expense_photo(bigint, int, text) to authenticated;
