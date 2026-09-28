-- Telegram: сповіщення про нову витрату отримує й той, хто її додав (як підтвердження —
-- із заголовком «✅ Ви додали витрату»). Скрипт можна виконувати повторно.

create or replace function private.telegram_expense_messages(eid bigint)
returns table (chat_id bigint, text text)
language sql
stable
security definer
set search_path = ''
as $$
  select l.chat_id,
         case when m.user_id = e.created_by then '✅ <b>Ви додали витрату</b> · ' else '💸 <b>Нова витрата</b> · ' end ||
         private.telegram_html(g.name) || chr(10) || chr(10) ||
         coalesce(nullif(c.icon, ''), '🧾') || ' <b>' || private.telegram_html(e.description) || '</b>' || chr(10) ||
         '💰 <b>' || private.telegram_money(e.amount, g.currency) || '</b>' ||
         case when e.currency is not null and e.original_amount is not null
              then ' <i>(' || private.telegram_money(e.original_amount, e.currency) || ')</i>' else '' end || chr(10) ||
         '👤 Заплатив(ла): <b>' || private.telegram_html(payer.name) || '</b>' || chr(10) ||
         case when e.created_by <> e.paid_by and m.user_id <> e.created_by then '✍️ Додав(ла): ' || private.telegram_html(author.name) || chr(10) else '' end ||
         '📅 ' || to_char(e.date, 'DD.MM.YYYY') || chr(10) ||
         case when nullif(trim(e.note), '') is not null then '💬 <i>' || private.telegram_html(trim(e.note)) || '</i>' || chr(10) else '' end ||
         chr(10) ||
         '<blockquote>' ||
         case when s.amount is not null then '🫵 Ваша витрата: <b>' || private.telegram_money(s.amount, g.currency) || '</b>'
              else '🙅 Вас немає серед тих, хто ділить цю витрату' end ||
         '</blockquote>' || chr(10) ||
         private.telegram_balance_line(private.member_balance(e.group_id, m.user_id), g.currency)
  from public.expenses e
  join public.groups g on g.id = e.group_id
  join public.profiles payer on payer.id = e.paid_by
  join public.profiles author on author.id = e.created_by
  left join public.categories c on c.id = e.category_id
  join public.group_members m on m.group_id = e.group_id and m.archived_at is null
  join private.telegram_links l on l.user_id = m.user_id
  left join public.expense_shares s on s.expense_id = e.id and s.user_id = m.user_id
  where e.id = eid;
$$;
revoke execute on function private.telegram_expense_messages(bigint) from public, anon, authenticated;
