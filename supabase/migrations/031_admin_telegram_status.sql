-- Адмінка: у списку користувачів видно, чи підключено Telegram-бота і чи доходять туди сповіщення.
-- Функція notify-telegram після кожного надсилання повідомляє базі результат (доставлено / помилка,
-- напр. людина заблокувала бота). Скрипт можна виконувати повторно.

alter table private.telegram_links add column if not exists last_sent_at timestamptz;
alter table private.telegram_links add column if not exists last_error text;
alter table private.telegram_links add column if not exists last_error_at timestamptz;

-- Результат надсилання в чат. Викликає лише функція notify-telegram (роль service_role) із секретом бота.
create or replace function public.telegram_report_delivery(secret text, chat bigint, ok boolean, error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if secret is null or not exists (select 1 from private.telegram_bot b where b.webhook_secret = secret) then
    raise exception 'forbidden';
  end if;
  if ok then
    update private.telegram_links set last_sent_at = now(), last_error = null, last_error_at = null where chat_id = chat;
  else
    update private.telegram_links set last_error = left(coalesce(error, 'невідома помилка'), 300), last_error_at = now()
    where chat_id = chat;
  end if;
end;
$$;
revoke execute on function public.telegram_report_delivery(text, bigint, boolean, text) from public, anon, authenticated;
do $$
begin
  grant execute on function public.telegram_report_delivery(text, bigint, boolean, text) to service_role;
exception when undefined_object then
  null; -- немає ролі service_role (локальна перевірка)
end;
$$;

-- Стан сповіщень кожного користувача для адмінки (окремо від admin_users, щоб не міняти її тип).
create or replace function public.admin_notify_status()
returns table (
  user_id uuid, telegram_linked boolean, telegram_linked_at timestamptz, telegram_last_sent_at timestamptz,
  telegram_error text, telegram_error_at timestamptz, notify_expense_email boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Лише для адміністратора';
  end if;
  return query
    select p.id, l.user_id is not null, l.linked_at, l.last_sent_at, l.last_error, l.last_error_at, p.notify_expense_email
    from public.profiles p
    left join private.telegram_links l on l.user_id = p.id;
end;
$$;
revoke execute on function public.admin_notify_status() from public, anon;
grant execute on function public.admin_notify_status() to authenticated;
