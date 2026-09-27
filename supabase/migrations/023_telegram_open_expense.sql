-- Telegram: під повідомленням про нову витрату — кнопка «Відкрити витрату» (сайт відкриває групу
-- з розгорнутою й підсвіченою витратою: #/groups/<група>/expenses/<витрата>) і кнопка «Група».
-- Скрипт можна виконувати повторно.

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
  -- Кнопки під повідомленням: відкрити саму витрату (група з розгорнутою витратою) або групу.
  select jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
           jsonb_build_object('text', '🧾 Відкрити витрату', 'url', site || '/#/groups/' || e.group_id || '/expenses/' || e.id),
           jsonb_build_object('text', '📂 Група', 'url', site || '/#/groups/' || e.group_id))))
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
