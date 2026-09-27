-- Telegram: гарніше повідомлення про нову витрату — іконка категорії, жирні суми, дата,
-- ваша частка окремою цитатою, кольоровий кружечок балансу і кнопка «Відкрити групу» під повідомленням.
-- Скрипт можна виконувати повторно.

-- Адреса сайту для кнопки «Відкрити групу».
alter table private.telegram_bot add column if not exists site_url text not null default 'https://finance.chinnect24.com';

create or replace function private.telegram_balance_line(balance bigint, currency text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when balance > 0 then '🟢 Ваш баланс у групі: <b>+' || private.telegram_money(balance, currency) || '</b> — вам винні'
    when balance < 0 then '🔴 Ваш баланс у групі: <b>−' || private.telegram_money(-balance, currency) || '</b> — ви винні'
    else '⚪️ Ваш баланс у групі: <b>' || private.telegram_money(0, currency) || '</b> — усе сплачено'
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
         '💸 <b>Нова витрата</b> · ' || private.telegram_html(g.name) || chr(10) || chr(10) ||
         coalesce(nullif(c.icon, ''), '🧾') || ' <b>' || private.telegram_html(e.description) || '</b>' || chr(10) ||
         '💰 <b>' || private.telegram_money(e.amount, g.currency) || '</b>' ||
         case when e.currency is not null and e.original_amount is not null
              then ' <i>(' || private.telegram_money(e.original_amount, e.currency) || ')</i>' else '' end || chr(10) ||
         '👤 Заплатив(ла): <b>' || private.telegram_html(payer.name) || '</b>' || chr(10) ||
         case when e.created_by <> e.paid_by then '✍️ Додав(ла): ' || private.telegram_html(author.name) || chr(10) else '' end ||
         '📅 ' || to_char(e.date, 'DD.MM.YYYY') || chr(10) || chr(10) ||
         '<blockquote>' ||
         case when s.amount is not null then '🫵 Ваша частка: <b>' || private.telegram_money(s.amount, g.currency) || '</b>'
              else '🙅 Вас немає серед тих, хто ділить цю витрату' end ||
         '</blockquote>' || chr(10) ||
         private.telegram_balance_line(private.member_balance(e.group_id, m.user_id), g.currency)
  from public.expenses e
  join public.groups g on g.id = e.group_id
  join public.profiles payer on payer.id = e.paid_by
  join public.profiles author on author.id = e.created_by
  left join public.categories c on c.id = e.category_id
  join public.group_members m on m.group_id = e.group_id and m.archived_at is null and m.user_id <> e.created_by
  join private.telegram_links l on l.user_id = m.user_id
  left join public.expense_shares s on s.expense_id = e.id and s.user_id = m.user_id
  where e.id = eid;
$$;
revoke execute on function private.telegram_expense_messages(bigint) from public, anon, authenticated;

create or replace function private.telegram_notify_expense()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  bot_token text;
  site text;
  buttons jsonb;
  m record;
begin
  if new.action <> 'created' or new.expense_id is null
     or not exists (select 1 from pg_namespace where nspname = 'net') then
    return null;
  end if;
  select b.token, rtrim(b.site_url, '/') into bot_token, site from private.telegram_bot b;
  if bot_token is null then
    return null;
  end if;
  -- Кнопка під повідомленням: відкрити групу на сайті.
  select jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
           jsonb_build_object('text', '📂 Відкрити групу', 'url', site || '/#/groups/' || e.group_id))))
    into buttons
    from public.expenses e where e.id = new.expense_id;
  for m in select * from private.telegram_expense_messages(new.expense_id) loop
    perform net.http_post(
      url := 'https://api.telegram.org/bot' || bot_token || '/sendMessage',
      body := jsonb_build_object('chat_id', m.chat_id, 'text', m.text, 'parse_mode', 'HTML',
                                 'reply_markup', buttons, 'link_preview_options', jsonb_build_object('is_disabled', true)),
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
  end loop;
  return null;
exception when others then
  raise warning 'Telegram: не вдалося надіслати сповіщення: %', sqlerrm;
  return null; -- сповіщення не повинні заважати додаванню витрати
end;
$$;
