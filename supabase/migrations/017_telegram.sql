-- Сповіщення в Telegram про нові витрати.
-- Людина в профілі натискає «Підключити Telegram» → відкривається бот з одноразовим кодом → бот
-- (через вебхук supabase/functions/telegram) прив'язує її чат. Коли в групі додають витрату, база сама
-- надсилає повідомлення всім прив'язаним учасникам групи, крім того, хто витрату додав.
-- Токен бота зберігається в private.telegram_bot (через API її не видно), його вносять один раз:
--   select private.telegram_setup('<токен від BotFather>', '<ім''я бота без @>', '<адреса вебхука>');
-- Скрипт можна виконувати повторно.

-- pg_net надсилає HTTP-запити з бази (у фоні, після завершення транзакції).
do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net недоступне — сповіщення в Telegram не надсилатимуться';
end;
$$;

-- ---------- Таблиці ----------

create table if not exists private.telegram_bot (
  id             boolean primary key default true check (id),
  token          text not null,
  username       text not null,
  webhook_secret text not null default replace(gen_random_uuid()::text, '-', ''),
  updated_at     timestamptz not null default now()
);

create table if not exists private.telegram_links (
  user_id   uuid primary key references public.profiles (id) on delete cascade,
  chat_id   bigint not null,
  linked_at timestamptz not null default now()
);

create table if not exists private.telegram_codes (
  code       text primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  expires_at timestamptz not null default now() + interval '30 minutes'
);

revoke all on private.telegram_bot, private.telegram_links, private.telegram_codes from public, anon, authenticated;

-- ---------- Налаштування бота (лише з SQL Editor) ----------

create or replace function private.telegram_setup(bot_token text, bot_username text, webhook_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret text;
begin
  insert into private.telegram_bot (token, username)
  values (trim(bot_token), trim(leading '@' from trim(bot_username)))
  on conflict (id) do update set token = excluded.token, username = excluded.username, updated_at = now()
  returning webhook_secret into secret;

  perform net.http_post(
    url := 'https://api.telegram.org/bot' || trim(bot_token) || '/setWebhook',
    body := jsonb_build_object('url', webhook_url, 'secret_token', secret, 'allowed_updates', jsonb_build_array('message')),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
end;
$$;
revoke execute on function private.telegram_setup(text, text, text) from public, anon, authenticated;

-- ---------- Для сайту ----------

-- Чи налаштовано бота і чи прив'язаний Telegram у поточного користувача.
create or replace function public.telegram_status()
returns table (bot_username text, linked boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select b.username, exists (select 1 from private.telegram_links l where l.user_id = auth.uid())
  from private.telegram_bot b
  where auth.uid() is not null;
$$;

-- Посилання на бота з одноразовим кодом (діє 30 хвилин).
create or replace function public.telegram_link_start()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  bot text;
  new_code text := replace(gen_random_uuid()::text, '-', '');
begin
  if auth.uid() is null then
    raise exception 'Потрібно увійти';
  end if;
  select username into bot from private.telegram_bot;
  if bot is null then
    raise exception 'Telegram-бота ще не налаштовано';
  end if;
  delete from private.telegram_codes where user_id = auth.uid() or expires_at < now();
  insert into private.telegram_codes (code, user_id) values (new_code, auth.uid());
  return 'https://t.me/' || bot || '?start=' || new_code;
end;
$$;

create or replace function public.telegram_unlink()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.telegram_links where user_id = auth.uid();
$$;

revoke execute on function public.telegram_status() from public, anon, authenticated;
revoke execute on function public.telegram_link_start() from public, anon, authenticated;
revoke execute on function public.telegram_unlink() from public, anon, authenticated;
grant execute on function public.telegram_status() to authenticated;
grant execute on function public.telegram_link_start() to authenticated;
grant execute on function public.telegram_unlink() to authenticated;

-- ---------- Вебхук: повідомлення, які люди пишуть боту ----------
-- Викликає лише функція supabase/functions/telegram (роль service_role). Повертає відповідь для Telegram
-- (метод sendMessage) або null.

create or replace function public.telegram_webhook(secret text, payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  msg jsonb := payload -> 'message';
  chat bigint;
  body text;
  start_code text;
  who uuid;
  who_name text;
  reply text;
begin
  if secret is null or not exists (select 1 from private.telegram_bot b where b.webhook_secret = secret) then
    raise exception 'forbidden';
  end if;
  if msg is null or msg -> 'chat' ->> 'type' is distinct from 'private' then
    return null;
  end if;
  chat := (msg -> 'chat' ->> 'id')::bigint;
  body := trim(coalesce(msg ->> 'text', ''));
  start_code := substring(body from '^/start\s+([A-Za-z0-9_-]+)');

  if start_code is not null then
    delete from private.telegram_codes c where c.code = start_code and c.expires_at > now()
    returning c.user_id into who;
    if who is null then
      reply := 'Посилання застаріло. Відкрийте профіль на сайті й натисніть «Підключити Telegram» ще раз.';
    else
      insert into private.telegram_links (user_id, chat_id) values (who, chat)
      on conflict (user_id) do update set chat_id = excluded.chat_id, linked_at = now();
      select p.name into who_name from public.profiles p where p.id = who;
      reply := format('✅ Готово, %s! Тепер я надсилатиму сюди нові витрати з ваших груп.' || chr(10) ||
                      'Вимкнути: /stop або кнопка в профілі на сайті.', who_name);
    end if;
  elsif body ~ '^/stop' then
    delete from private.telegram_links l where l.chat_id = chat;
    reply := 'Сповіщення вимкнено. Увімкнути знову можна в профілі на сайті.';
  else
    reply := 'Я надсилаю сповіщення про нові витрати у спільних групах. ' ||
             'Щоб їх отримувати, відкрийте профіль на сайті й натисніть «Підключити Telegram».';
  end if;

  return jsonb_build_object('method', 'sendMessage', 'chat_id', chat, 'text', reply);
end;
$$;

revoke execute on function public.telegram_webhook(text, jsonb) from public, anon, authenticated;
do $$
begin
  grant execute on function public.telegram_webhook(text, jsonb) to service_role;
exception when undefined_object then
  null; -- немає ролі service_role (локальна перевірка)
end;
$$;

-- ---------- Надсилання сповіщень ----------

-- 123456 → «1 234,56 грн»
create or replace function private.telegram_money(kopecks bigint, currency text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(to_char(kopecks / 100, 'FM999,999,999,990'), ',', ' ') || ',' || lpad((kopecks % 100)::text, 2, '0')
         || ' ' || case currency when 'UAH' then 'грн' else currency end;
$$;

-- Тексти повідомлень для кожного прив'язаного учасника групи (крім автора витрати й тих, хто сховав групу в архів).
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
         case when s.amount is not null then 'Ваша частка: ' || private.telegram_money(s.amount, g.currency)
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

-- Спрацьовує, коли в історії з'являється запис «created» — на цей момент частки вже збережено.
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
      body := jsonb_build_object('chat_id', m.chat_id, 'text', m.text),
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
  end loop;
  return null;
exception when others then
  raise warning 'Telegram: не вдалося надіслати сповіщення: %', sqlerrm;
  return null; -- сповіщення не повинні заважати додаванню витрати
end;
$$;

drop trigger if exists telegram_notify on public.expense_history;
create trigger telegram_notify
  after insert on public.expense_history
  for each row execute function private.telegram_notify_expense();
