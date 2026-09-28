-- Адмінка: видалення користувача, який ще нічого не робив (без груп, витрат і повернень боргів).
-- Видаляється акаунт входу (auth.users), а з ним каскадом — профіль, прив'язка Telegram тощо.
-- Скрипт можна виконувати повторно.

create or replace function public.admin_delete_user(target uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Лише для адміністратора';
  end if;
  if target = auth.uid() then
    raise exception 'Не можна видалити самого себе';
  end if;
  if exists (select 1 from private.admins a where a.user_id = target) then
    raise exception 'Спершу заберіть у користувача права адміністратора';
  end if;
  if exists (select 1 from public.group_members m where m.user_id = target)
     or exists (select 1 from public.groups g where g.created_by = target)
     or exists (select 1 from public.expenses e where e.paid_by = target or e.created_by = target)
     or exists (select 1 from public.expense_shares s where s.user_id = target)
     or exists (select 1 from public.settlements s where target in (s.from_user, s.to_user, s.created_by)) then
    raise exception 'Користувач уже має групи або витрати — його не можна видалити';
  end if;
  delete from auth.users u where u.id = target;
  delete from public.profiles p where p.id = target; -- якщо профіль залишився без акаунта
end;
$$;
revoke execute on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_delete_user(uuid) to authenticated;
