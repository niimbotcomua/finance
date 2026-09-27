-- Слово «частка» на сайті замінили на «витрата»: те саме — у повідомленнях Telegram і текстах помилок.
-- Скрипт можна виконувати повторно.

create or replace function private.check_expense(
  gid bigint, amount bigint, paid_by uuid, shares jsonb, category_id bigint
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  share_total bigint;
begin
  if not private.is_group_member(gid) then
    raise exception 'Групу не знайдено';
  end if;
  if not exists (select 1 from public.group_members where group_id = gid and user_id = paid_by) then
    raise exception 'Платник не належить до групи';
  end if;
  if jsonb_typeof(shares) <> 'array' or jsonb_array_length(shares) = 0 then
    raise exception 'Вкажіть, між ким розділити витрату';
  end if;
  if exists (
    select 1 from jsonb_array_elements(shares) s
    where not exists (
      select 1 from public.group_members
      where group_id = gid and user_id = (s ->> 'user_id')::uuid
    )
  ) then
    raise exception 'Учасник не належить до групи';
  end if;
  if exists (select 1 from jsonb_array_elements(shares) s where (s ->> 'amount')::bigint < 0) then
    raise exception 'Некоректна витрата учасника';
  end if;
  select coalesce(sum((s ->> 'amount')::bigint), 0) into share_total from jsonb_array_elements(shares) s;
  if share_total <> amount then
    raise exception 'Сума витрат учасників має дорівнювати сумі витрати';
  end if;
  if category_id is not null and not exists (select 1 from public.categories c where c.id = category_id) then
    raise exception 'Тег не знайдено';
  end if;
end;
$$;

create or replace function private.telegram_expense_messages(eid bigint)
returns table (chat_id bigint, text text)
language sql
stable
security definer
set search_path = ''
as $$
  select l.chat_id,
         '💸 Нова витрата в групі «' || g.name || '»' || chr(10) ||
         e.description || ' — ' || private.telegram_money(e.amount, g.currency) ||
         case when e.currency is not null and e.original_amount is not null
              then ' (' || private.telegram_money(e.original_amount, e.currency) || ')' else '' end || chr(10) ||
         'Заплатив(ла): ' || payer.name ||
         case when e.created_by <> e.paid_by then ' · додав(ла): ' || author.name else '' end || chr(10) ||
         case when s.amount is not null then 'Ваша витрата: ' || private.telegram_money(s.amount, g.currency)
              else 'Вас немає серед тих, хто ділить цю витрату' end
  from public.expenses e
  join public.groups g on g.id = e.group_id
  join public.profiles payer on payer.id = e.paid_by
  join public.profiles author on author.id = e.created_by
  join public.group_members m on m.group_id = e.group_id and m.archived_at is null and m.user_id <> e.created_by
  join private.telegram_links l on l.user_id = m.user_id
  left join public.expense_shares s on s.expense_id = e.id and s.user_id = m.user_id
  where e.id = eid;
$$;
revoke execute on function private.telegram_expense_messages(bigint) from public, anon, authenticated;
