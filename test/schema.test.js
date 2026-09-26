// Перевіряє supabase/schema.sql на справжньому Postgres (PGlite) з імітацією схеми auth від Supabase.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text not null,
    raw_user_meta_data jsonb not null default '{}'
  );
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`;

let db;
const users = {};

async function signUp(key, email, name) {
  const { rows } = await db.query(
    'insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id',
    [email, { name }],
  );
  users[key] = rows[0].id;
}

/** Виконує запит від імені користувача з увімкненим RLS (як supabase-js). */
async function as(key, sql, params = []) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [key ? users[key] : '']);
  await db.exec(`set role ${key ? 'authenticated' : 'anon'}`);
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec('reset role');
  }
}

const rejects = (promise, message) => assert.rejects(promise, (err) => err.message.includes(message));

before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  await db.exec(schema);
  await db.exec(schema); // скрипт можна виконати повторно
  await signUp('anna', 'anna@example.com', 'Анна');
  await signUp('bohdan', 'Bohdan@Example.com', 'Богдан');
  await signUp('vira', 'vira@example.com', '');
  await signUp('stranger', 'stranger@example.com', 'Чужий');
});

test('профіль створюється під час реєстрації', async () => {
  const rows = await db.query('select name from public.profiles where id = $1', [users.vira]);
  assert.equal(rows.rows[0].name, 'vira');
});

test('повний сценарій з правилами доступу', async () => {
  const [{ create_group: gid }] = await as('anna', 'select public.create_group(group_name => $1)', ['Поїздка']);

  // Чужі не бачать групу і не можуть нічого в ній робити.
  assert.equal((await as('stranger', 'select * from public.groups')).length, 0);
  await rejects(as('stranger', 'select public.add_group_member($1, $2)', [gid, 'stranger@example.com']), 'Групу не знайдено');
  assert.equal((await as(null, 'select * from public.my_groups()').catch(() => 'denied')), 'denied');

  await as('anna', 'select public.add_group_member(gid => $1, member_email => $2)', [gid, 'bohdan@example.com']);
  await as('anna', 'select public.add_group_member($1, $2)', [gid, 'VIRA@example.com']);
  await rejects(as('anna', 'select public.add_group_member($1, $2)', [gid, 'nobody@example.com']), 'не знайдено');
  await rejects(as('anna', 'select public.add_group_member($1, $2)', [gid, 'vira@example.com']), 'уже є учасником');

  // Прямий запис у таблиці заборонено — лише через функції.
  await rejects(as('anna', 'insert into public.group_members (group_id, user_id) values ($1, $2)', [gid, users.stranger]), 'permission denied');

  const addExpense = (who, amount, paidBy, shares) =>
    // Іменовані аргументи — так їх передає supabase.rpc().
    as(who, 'select public.add_expense(gid => $1, description => $2, amount => $3, paid_by => $4, shares => $5::jsonb)', [
      gid, 'Витрата', amount, users[paidBy],
      JSON.stringify(shares.map(([u, a]) => ({ user_id: users[u], amount: a }))),
    ]);

  await addExpense('anna', 90000, 'anna', [['anna', 30000], ['bohdan', 30000], ['vira', 30000]]);
  await addExpense('bohdan', 30000, 'bohdan', [['vira', 20000], ['bohdan', 10000], ['anna', 0]]);
  await rejects(addExpense('anna', 100, 'anna', [['vira', 50]]), 'Сума часток');
  await rejects(addExpense('anna', 100, 'anna', [['stranger', 100]]), 'не належить');
  await rejects(addExpense('anna', 100, 'stranger', [['anna', 100]]), 'Платник');

  assert.equal((await as('vira', 'select * from public.expenses')).length, 2);
  assert.equal((await as('vira', 'select * from public.expense_shares')).length, 5); // нульова частка не зберігається
  assert.equal((await as('stranger', 'select * from public.expenses')).length, 0);
  assert.equal((await as('stranger', 'select * from public.expense_shares')).length, 0);

  // Профілі: бачу себе і співучасників, але не чужих.
  const visible = (await as('anna', 'select id from public.profiles')).map((r) => r.id).sort();
  assert.deepEqual(visible, [users.anna, users.bohdan, users.vira].sort());

  const balance = async (who) => Number((await as(who, 'select my_balance from public.my_groups()'))[0].my_balance);
  assert.equal(await balance('anna'), 60000);
  assert.equal(await balance('bohdan'), -10000);
  assert.equal(await balance('vira'), -50000);

  // Повернення боргу.
  await as('vira', 'insert into public.settlements (group_id, from_user, to_user, amount) values ($1, $2, $3, 50000)',
    [gid, users.vira, users.anna]);
  assert.equal(await balance('vira'), 0);
  assert.equal(await balance('anna'), 10000);
  await rejects(
    as('vira', 'insert into public.settlements (group_id, from_user, to_user, amount) values ($1, $2, $3, 100)',
      [gid, users.vira, users.stranger]),
    'row-level security',
  );
  await rejects(
    as('stranger', 'insert into public.settlements (group_id, from_user, to_user, amount) values ($1, $2, $3, 100)',
      [gid, users.vira, users.anna]),
    'row-level security',
  );

  // Видалення учасника з історією заборонено.
  await rejects(as('anna', 'select public.remove_group_member($1, $2)', [gid, users.vira]), 'історію');

  // Чужий не може видалити витрату (RLS просто не знаходить рядок).
  await as('stranger', 'delete from public.expenses');
  assert.equal((await as('anna', 'select * from public.expenses')).length, 2);
});

test('учасника без історії можна видалити', async () => {
  const [{ create_group: gid }] = await as('bohdan', 'select public.create_group($1)', ['Офіс']);
  await as('bohdan', 'select public.add_group_member($1, $2)', [gid, 'stranger@example.com']);
  assert.equal((await as('stranger', 'select * from public.my_groups()')).length, 1);
  await as('bohdan', 'select public.remove_group_member(gid => $1, member => $2)', [gid, users.stranger]);
  assert.equal((await as('stranger', 'select * from public.my_groups()')).length, 0);
});
