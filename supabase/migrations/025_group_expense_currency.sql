-- Валюта за замовчуванням для нових витрат у групі (напр. у поїздці — леї, хоча основна валюта — гривня).
-- null — основна валюта групи. Можна обрати основну або будь-яку валюту з курсом у налаштуваннях групи.
-- Змінює будь-який учасник групи (так само, як курси). Скрипт можна виконувати повторно.

alter table public.groups add column if not exists expense_currency text references public.currencies (code);

create or replace function public.set_group_expense_currency(gid bigint, currency text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  base text;
begin
  select g.currency into base from public.groups g where g.id = gid;
  if base is null or not private.is_group_member(gid) then
    raise exception 'Групу не знайдено';
  end if;
  if set_group_expense_currency.currency is not null
     and set_group_expense_currency.currency <> base
     and not exists (select 1 from public.group_rates r
                     where r.group_id = gid and r.currency = set_group_expense_currency.currency) then
    raise exception 'Спершу додайте курс цієї валюти';
  end if;
  update public.groups g
     set expense_currency = nullif(set_group_expense_currency.currency, base)
   where g.id = gid;
end;
$$;
revoke execute on function public.set_group_expense_currency(bigint, text) from public, anon;
grant execute on function public.set_group_expense_currency(bigint, text) to authenticated;

-- Прибрали курс валюти, що стояла за замовчуванням, — повертаємося до основної.
create or replace function private.clear_group_expense_currency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.groups g set expense_currency = null
   where g.id = old.group_id and g.expense_currency = old.currency;
  return null;
end;
$$;

drop trigger if exists clear_group_expense_currency on public.group_rates;
create trigger clear_group_expense_currency
  after delete on public.group_rates
  for each row execute function private.clear_group_expense_currency();
