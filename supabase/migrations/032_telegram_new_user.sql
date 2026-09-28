-- Telegram: адмінам (з підключеним ботом) приходить повідомлення, коли реєструється новий користувач.
-- Скрипт можна виконувати повторно.

create or replace function private.telegram_notify_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  bot record;
  provider text;
  total bigint;
  message text;
  m record;
begin
  if not exists (select 1 from pg_namespace where nspname = 'net') then
    return null;
  end if;
  select * into bot from private.telegram_bot;
  if bot.token is null then
    return null;
  end if;
  select to_jsonb(u) -> 'raw_app_meta_data' ->> 'provider' into provider from auth.users u where u.id = new.id;
  select count(*) into total from public.profiles;
  message := '🎉 <b>Новий користувач</b>' || chr(10) || chr(10) ||
             '👤 <b>' || private.telegram_html(coalesce(nullif(new.name, ''), 'Без імені')) || '</b>' || chr(10) ||
             '📧 ' || private.telegram_html(new.email) || chr(10) ||
             '🔑 ' || case provider when 'google' then 'Через Google' when 'email' then 'Email і пароль'
                            else coalesce(private.telegram_html(provider), 'невідомо') end || chr(10) ||
             '📅 ' || to_char(now() at time zone 'Europe/Kyiv', 'DD.MM.YYYY HH24:MI') || chr(10) || chr(10) ||
             '👥 Усього користувачів: <b>' || total || '</b>';
  for m in
    select l.chat_id from private.admins a join private.telegram_links l on l.user_id = a.user_id where a.user_id <> new.id
  loop
    perform net.http_post(
      url := 'https://api.telegram.org/bot' || bot.token || '/sendMessage',
      body := jsonb_build_object('chat_id', m.chat_id, 'text', message, 'parse_mode', 'HTML',
                                 'reply_markup', jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
                                   jsonb_build_object('text', '🛡 Відкрити адмінку', 'url', rtrim(bot.site_url, '/') || '/#/admin')))),
                                 'link_preview_options', jsonb_build_object('is_disabled', true)),
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
  end loop;
  return null;
exception when others then
  raise warning 'Telegram: не вдалося повідомити адмінів про нового користувача: %', sqlerrm;
  return null; -- сповіщення не повинні заважати реєстрації
end;
$$;
revoke execute on function private.telegram_notify_new_user() from public, anon, authenticated;

drop trigger if exists telegram_new_user on public.profiles;
create trigger telegram_new_user
  after insert on public.profiles
  for each row execute function private.telegram_notify_new_user();
