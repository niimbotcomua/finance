-- Сповіщення на пошту про нові витрати.
-- У профілі людина вмикає «Надсилати на пошту нові витрати» (profiles.notify_expense_email). Коли в групі
-- додають витрату, база надсилає дані функції supabase/functions/notify-expense, а та — листи всім учасникам
-- групи, які це ввімкнули (крім автора витрати й тих, хто сховав групу в архів).
-- Адресу функції та секрет вносять один раз (секрет той самий, що NOTIFY_SECRET у секретах функцій):
--   select private.email_notify_setup('https://<project>.supabase.co/functions/v1/notify-expense', '<секрет>');
-- Скрипт можна виконувати повторно.

alter table public.profiles add column if not exists notify_expense_email boolean not null default false;

-- Змінювати можна лише своє (політика «profiles: змінювати свій» уже діє) і лише ці колонки.
grant update (name, avatar_path, design, notify_expense_email) on public.profiles to authenticated;

create table if not exists private.email_notify (
  id         boolean primary key default true check (id),
  url        text not null,
  secret     text not null,
  updated_at timestamptz not null default now()
);
revoke all on private.email_notify from public, anon, authenticated;

create or replace function private.email_notify_setup(function_url text, notify_secret text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.email_notify (url, secret) values (trim(function_url), trim(notify_secret))
  on conflict (id) do update set url = excluded.url, secret = excluded.secret, updated_at = now();
$$;
revoke execute on function private.email_notify_setup(text, text) from public, anon, authenticated;

-- Дані для листів про витрату: хто отримує (з увімкненим сповіщенням) і що в листі.
create or replace function private.email_expense_payload(eid bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'group_id', g.id,
    'group_name', g.name,
    'description', e.description,
    'amount', private.telegram_money(e.amount, g.currency),
    'original', case when e.currency is not null and e.original_amount is not null
                     then private.telegram_money(e.original_amount, e.currency) end,
    'date', e.date,
    'payer', payer.name,
    'author', case when e.created_by <> e.paid_by then author.name end,
    'recipients', coalesce((
      select jsonb_agg(jsonb_build_object(
        'email', p.email,
        'name', p.name,
        'share', case when s.amount is not null then private.telegram_money(s.amount, g.currency) end
      ) order by p.name)
      from public.group_members m
      join public.profiles p on p.id = m.user_id
      left join public.expense_shares s on s.expense_id = e.id and s.user_id = m.user_id
      where m.group_id = e.group_id and m.archived_at is null and m.user_id <> e.created_by and p.notify_expense_email
    ), '[]'::jsonb)
  )
  from public.expenses e
  join public.groups g on g.id = e.group_id
  join public.profiles payer on payer.id = e.paid_by
  join public.profiles author on author.id = e.created_by
  where e.id = eid;
$$;
revoke execute on function private.email_expense_payload(bigint) from public, anon, authenticated;

-- Спрацьовує, коли в історії з'являється запис «created» — на цей момент частки вже збережено.
create or replace function private.email_notify_expense()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg record;
  payload jsonb;
begin
  if new.action <> 'created' or new.expense_id is null
     or not exists (select 1 from pg_namespace where nspname = 'net') then
    return null;
  end if;
  select * into cfg from private.email_notify;
  if cfg.url is null then
    return null;
  end if;
  payload := private.email_expense_payload(new.expense_id);
  if payload is null or jsonb_array_length(payload -> 'recipients') = 0 then
    return null;
  end if;
  perform net.http_post(
    url := cfg.url,
    body := payload,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Notify-Secret', cfg.secret)
  );
  return null;
exception when others then
  raise warning 'Пошта: не вдалося надіслати сповіщення: %', sqlerrm;
  return null; -- сповіщення не повинні заважати додаванню витрати
end;
$$;

drop trigger if exists email_notify on public.expense_history;
create trigger email_notify
  after insert on public.expense_history
  for each row execute function private.email_notify_expense();
