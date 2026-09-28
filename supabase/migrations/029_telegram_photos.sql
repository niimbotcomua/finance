-- Telegram: фото квитанцій у сповіщенні про нову витрату + коментар до витрати.
-- Фото додаються до витрати вже після її створення, а надіслати файл у Telegram база сама не може.
-- Тому, коли налаштовано адресу функції supabase/functions/notify-telegram, база лише «штовхає» її з номером
-- витрати, а функція за кілька секунд (коли фото вже прикріплено) бере готові тексти з бази й надсилає
-- повідомлення з фото. Без налаштованої адреси все працює як раніше — текстом прямо з бази.
-- Увімкнути (один раз, після розгортання функції):
--   select private.telegram_notify_setup('https://<project>.supabase.co/functions/v1/notify-telegram');
-- Скрипт можна виконувати повторно.

alter table private.telegram_bot add column if not exists notify_url text;

create or replace function private.telegram_notify_setup(function_url text)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.telegram_bot set notify_url = nullif(trim(function_url), ''), updated_at = now();
$$;
revoke execute on function private.telegram_notify_setup(text) from public, anon, authenticated;

-- Текст повідомлення — тепер і з коментарем до витрати (якщо він є).
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
  join public.group_members m on m.group_id = e.group_id and m.archived_at is null and m.user_id <> e.created_by
  join private.telegram_links l on l.user_id = m.user_id
  left join public.expense_shares s on s.expense_id = e.id and s.user_id = m.user_id
  where e.id = eid;
$$;
revoke execute on function private.telegram_expense_messages(bigint) from public, anon, authenticated;

-- Кнопки під повідомленням: відкрити саму витрату або групу.
create or replace function private.telegram_expense_buttons(eid bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
           jsonb_build_object('text', '🧾 Відкрити витрату', 'url', rtrim(b.site_url, '/') || '/#/groups/' || e.group_id || '/expenses/' || e.id),
           jsonb_build_object('text', '📂 Група', 'url', rtrim(b.site_url, '/') || '/#/groups/' || e.group_id))))
  from public.expenses e, private.telegram_bot b
  where e.id = eid;
$$;
revoke execute on function private.telegram_expense_buttons(bigint) from public, anon, authenticated;

create or replace function private.telegram_notify_expense()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  bot record;
  m record;
begin
  if new.action <> 'created' or new.expense_id is null
     or not exists (select 1 from pg_namespace where nspname = 'net') then
    return null;
  end if;
  select * into bot from private.telegram_bot;
  if bot.token is null or not exists (select 1 from private.telegram_expense_messages(new.expense_id)) then
    return null;
  end if;
  if bot.notify_url is not null then
    -- Повідомлення з фото надішле функція notify-telegram.
    perform net.http_post(
      url := bot.notify_url,
      body := jsonb_build_object('expense_id', new.expense_id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'X-Notify-Secret', bot.webhook_secret)
    );
    return null;
  end if;
  for m in select * from private.telegram_expense_messages(new.expense_id) loop
    perform net.http_post(
      url := 'https://api.telegram.org/bot' || bot.token || '/sendMessage',
      body := jsonb_build_object('chat_id', m.chat_id, 'text', m.text, 'parse_mode', 'HTML',
                                 'reply_markup', private.telegram_expense_buttons(new.expense_id),
                                 'link_preview_options', jsonb_build_object('is_disabled', true)),
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
  end loop;
  return null;
exception when others then
  raise warning 'Telegram: не вдалося надіслати сповіщення: %', sqlerrm;
  return null; -- сповіщення не повинні заважати додаванню витрати
end;
$$;

-- Усе, що потрібно функції notify-telegram для сповіщення про витрату: токен бота, тексти для кожного
-- чату, кнопки й фото квитанцій. Викликає лише сама функція (роль service_role) із секретом бота.
create or replace function public.telegram_expense_notification(secret text, eid bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  bot record;
begin
  select * into bot from private.telegram_bot;
  if secret is null or bot.webhook_secret is distinct from secret then
    raise exception 'forbidden';
  end if;
  return (
    select jsonb_build_object(
      'token', bot.token,
      'buttons', private.telegram_expense_buttons(e.id),
      'photos', to_jsonb(array_remove(array[e.receipt_path, e.receipt_path2], null)),
      'messages', coalesce((
        select jsonb_agg(jsonb_build_object('chat_id', t.chat_id, 'text', t.text))
        from private.telegram_expense_messages(e.id) t
      ), '[]'::jsonb))
    from public.expenses e
    where e.id = eid
  );
end;
$$;
revoke execute on function public.telegram_expense_notification(text, bigint) from public, anon, authenticated;
do $$
begin
  grant execute on function public.telegram_expense_notification(text, bigint) to service_role;
exception when undefined_object then
  null; -- немає ролі service_role (локальна перевірка)
end;
$$;
