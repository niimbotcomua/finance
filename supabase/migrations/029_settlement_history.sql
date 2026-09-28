-- Повернення боргу теж потрапляють в «Історію змін»: хто записав і хто скасував переказ.
-- Інакше видалений переказ непомітно повертає борг. Скрипт можна виконувати повторно.

alter table public.expense_history drop constraint if exists expense_history_action_check;
alter table public.expense_history add constraint expense_history_action_check
  check (action in ('created', 'updated', 'deleted', 'settled', 'unsettled'));

create or replace function private.log_settlement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.settlements;
begin
  s := case when tg_op = 'INSERT' then new else old end;
  -- Група видаляється цілком — записувати нікуди.
  if not exists (select 1 from public.groups g where g.id = s.group_id) then
    return null;
  end if;
  insert into public.expense_history (group_id, expense_id, action, changed_by, old_data, new_data)
  values (s.group_id, null,
          case when tg_op = 'INSERT' then 'settled' else 'unsettled' end,
          auth.uid(),
          case when tg_op = 'DELETE' then jsonb_build_object('from_user', s.from_user, 'to_user', s.to_user,
            'amount', s.amount, 'date', s.date, 'note', s.note) end,
          case when tg_op = 'INSERT' then jsonb_build_object('from_user', s.from_user, 'to_user', s.to_user,
            'amount', s.amount, 'date', s.date, 'note', s.note) end);
  return null;
end;
$$;

drop trigger if exists settlements_log on public.settlements;
create trigger settlements_log
  after insert or delete on public.settlements
  for each row execute function private.log_settlement();
