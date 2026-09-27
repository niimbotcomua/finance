-- Telegram: у повідомленні про нову витрату — окремим жирним рядком баланс отримувача в цій групі
-- (так само, як на сайті: заплатив − його витрати + повернув боргів − отримав повернень).
-- Повідомлення тепер у розмітці HTML, тому назви й імена екрануються.
-- Скрипт можна виконувати повторно.

-- Баланс учасника в групі (у сотих частках основної валюти групи): > 0 — йому винні, < 0 — винен він.
create or replace function private.member_balance(gid bigint, uid uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select sum(e.amount) from public.expenses e where e.group_id = gid and e.paid_by = uid), 0)
       - coalesce((select sum(s.amount) from public.expense_shares s join public.expenses e on e.id = s.expense_id
                   where e.group_id = gid and s.user_id = uid), 0)
       + coalesce((select sum(t.amount) from public.settlements t where t.group_id = gid and t.from_user = uid), 0)
       - coalesce((select sum(t.amount) from public.settlements t where t.group_id = gid and t.to_user = uid), 0);
$$;
revoke execute on function private.member_balance(bigint, uuid) from public, anon, authenticated;

-- Екранування для parse_mode = HTML.
create or replace function private.telegram_html(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(value, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
$$;

create or replace function private.telegram_balance_line(balance bigint, currency text)
returns text
language sql
immutable
set search_path = ''
as $$
  select '<b>' || case
    when balance > 0 then 'Ваш баланс у групі: +' || private.telegram_money(balance, currency) || ' — вам винні'
    when balance < 0 then 'Ваш баланс у групі: −' || private.telegram_money(-balance, currency) || ' — ви винні'
    else 'Ваш баланс у групі: ' || private.telegram_money(0, currency) || ' — усе сплачено'
  end || '</b>';
$$;

create or replace function private.telegram_expense_messages(eid bigint)
returns table (chat_id bigint, text text)
language sql
stable
security definer
set search_path = ''
as $$
  select l.chat_id,
         '💸 Нова витрата в групі «' || private.telegram_html(g.name) || '»' || chr(10) ||
         private.telegram_html(e.description) || ' — ' || private.telegram_money(e.amount, g.currency) ||
         case when e.currency is not null and e.original_amount is not null
              then ' (' || private.telegram_money(e.original_amount, e.currency) || ')' else '' end || chr(10) ||
         'Заплатив(ла): ' || private.telegram_html(payer.name) ||
         case when e.created_by <> e.paid_by then ' · додав(ла): ' || private.telegram_html(author.name) else '' end || chr(10) ||
         case when s.amount is not null then 'Ваша витрата: ' || private.telegram_money(s.amount, g.currency)
              else 'Вас немає серед тих, хто ділить цю витрату' end || chr(10) || chr(10) ||
         private.telegram_balance_line(private.member_balance(e.group_id, m.user_id), g.currency)
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

create or replace function private.telegram_notify_expense()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  bot_token text;
  m record;
begin
  if new.action <> 'created' or new.expense_id is null
     or not exists (select 1 from pg_namespace where nspname = 'net') then
    return null;
  end if;
  select b.token into bot_token from private.telegram_bot b;
  if bot_token is null then
    return null;
  end if;
  for m in select * from private.telegram_expense_messages(new.expense_id) loop
    perform net.http_post(
      url := 'https://api.telegram.org/bot' || bot_token || '/sendMessage',
      body := jsonb_build_object('chat_id', m.chat_id, 'text', m.text, 'parse_mode', 'HTML'),
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
  end loop;
  return null;
exception when others then
  raise warning 'Telegram: не вдалося надіслати сповіщення: %', sqlerrm;
  return null; -- сповіщення не повинні заважати додаванню витрати
end;
$$;
