-- Видалення порожньої групи.
-- Видалити може лише автор групи і лише якщо в ній немає витрат і повернень боргів
-- (учасники, курси, запрошення, історія видаляються разом із групою).
-- Скрипт можна виконувати повторно.

create or replace function public.delete_group(gid bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  author uuid;
begin
  select g.created_by into author from public.groups g where g.id = gid;
  if author is null or not private.is_group_member(gid) then
    raise exception 'Групу не знайдено';
  end if;
  if author <> auth.uid() then
    raise exception 'Видалити групу може лише її автор';
  end if;
  if exists (select 1 from public.expenses e where e.group_id = gid)
     or exists (select 1 from public.settlements s where s.group_id = gid) then
    raise exception 'У групі вже є витрати чи повернення боргів — таку групу видалити не можна (її можна перенести в архів)';
  end if;
  delete from public.groups g where g.id = gid;
end;
$$;

revoke execute on function public.delete_group(bigint) from public, anon, authenticated;
grant execute on function public.delete_group(bigint) to authenticated;
