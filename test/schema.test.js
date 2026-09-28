// Перевіряє міграції supabase/migrations/*.sql на справжньому Postgres (PGlite) з імітацією схеми auth від Supabase.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

  create schema storage;
  create table storage.buckets (
    id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text
  );
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  grant usage on schema storage to anon, authenticated;
  grant select, insert, delete on storage.objects to authenticated;
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
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const migrations = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => readFileSync(new URL(f, dir), 'utf8'));
  for (const sql of migrations) await db.exec(sql);
  for (const sql of migrations) await db.exec(sql); // міграції можна виконати повторно
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
  await rejects(as('anna', 'select public.add_group_member($1, $2)', [gid, 'nobody@example.com']), 'не зареєстрований');
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
  await rejects(addExpense('anna', 100, 'anna', [['vira', 50]]), 'Сума витрат учасників');
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

  // Змінювати можна лише своє ім'я, але не email (інакше можна перехопити чужі запрошення).
  await as('anna', "update public.profiles set name = 'Ганна' where id = $1", [users.anna]);
  await rejects(as('anna', "update public.profiles set email = 'victim@example.com' where id = $1", [users.anna]), 'permission denied');

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

test('посилання-запрошення', async () => {
  await signUp('newbie', 'newbie@example.com', 'Новенький');
  const [{ create_group: gid }] = await as('anna', 'select public.create_group(group_name => $1)', ['Дача']);
  const [{ invite_token: token }] = await as('anna', 'select invite_token from public.groups where id = $1', [gid]);

  // Назву групи видно за посиланням навіть до входу, а без посилання — ні.
  const [invite] = await as(null, 'select * from public.get_group_invite(token => $1)', [token]);
  assert.equal(invite.name, 'Дача');
  assert.equal(invite.already_member, false);
  assert.equal((await as(null, 'select * from public.get_group_invite(token => gen_random_uuid())')).length, 0);
  await rejects(as(null, 'select public.join_group(token => $1)', [token]), 'permission denied');

  // Приєднання за посиланням (повторне — без помилки).
  assert.equal((await as('newbie', 'select public.join_group(token => $1)', [token]))[0].join_group, gid);
  await as('newbie', 'select public.join_group(token => $1)', [token]);
  assert.equal((await as('newbie', 'select * from public.my_groups()')).length, 1);
  assert.equal((await as('newbie', 'select * from public.get_group_invite(token => $1)', [token]))[0].already_member, true);

  // Оновлення посилання: старе більше не працює; чужий не може оновити.
  await rejects(as('stranger', 'select public.reset_group_invite(gid => $1)', [gid]), 'Групу не знайдено');
  const [{ reset_group_invite: fresh }] = await as('anna', 'select public.reset_group_invite(gid => $1)', [gid]);
  assert.notEqual(fresh, token);
  await rejects(as('stranger', 'select public.join_group(token => $1)', [token]), 'недійсне');
  await as('stranger', 'select public.join_group(token => $1)', [fresh]);
  assert.equal((await as('stranger', 'select id from public.groups where id = $1', [gid])).length, 1);

  // Незареєстрований email — підказка про посилання.
  await rejects(as('anna', 'select public.add_group_member(gid => $1, member_email => $2)', [gid, 'ghost@example.com']), 'посилання-запрошення');
});

test('назву групи змінює лише автор', async () => {
  const [{ create_group: gid }] = await as('anna', 'select public.create_group($1)', ['Стара назва']);
  await as('anna', 'select public.add_group_member($1, $2)', [gid, 'bohdan@example.com']);

  // Учасник (не автор) — RLS просто не знаходить рядок для зміни.
  assert.equal((await as('bohdan', 'update public.groups set name = $1 where id = $2 returning id', ['Злам', gid])).length, 0);
  assert.equal((await as('anna', 'update public.groups set name = $1 where id = $2 returning name', ['Нова назва', gid]))[0].name, 'Нова назва');
  await rejects(as('anna', 'update public.groups set created_by = $1 where id = $2', [users.bohdan, gid]), 'permission denied');
});

test('аватар: лише у власній папці', async () => {
  await as('anna', 'update public.profiles set avatar_path = $1 where id = $2', [`${users.anna}/a.jpg`, users.anna]);
  await rejects(
    as('anna', 'update public.profiles set avatar_path = $1 where id = $2', [`${users.bohdan}/a.jpg`, users.anna]),
    'profiles_avatar_path_check',
  );
  // Файли: завантажити можна лише у свою папку.
  await as('anna', "insert into storage.objects (bucket_id, name) values ('avatars', $1)", [`${users.anna}/a.jpg`]);
  await rejects(
    as('anna', "insert into storage.objects (bucket_id, name) values ('avatars', $1)", [`${users.bohdan}/x.jpg`]),
    'row-level security',
  );
  assert.equal((await as('bohdan', 'select * from storage.objects')).length, 0);
  await as('bohdan', 'delete from storage.objects');
  assert.equal((await as('anna', 'select * from storage.objects')).length, 1);
});

test('теги витрат і супер-адмін', async () => {
  const categories = await as('vira', 'select id, name from public.categories order by id');
  assert.ok(categories.length >= 5);

  // Звичайний користувач не може керувати тегами і не бачить список користувачів.
  assert.equal((await as('vira', 'select public.am_i_admin() as a'))[0].a, false);
  await rejects(as('vira', "insert into public.categories (name) values ('Хак')"), 'row-level security');
  await as('vira', 'delete from public.categories');
  assert.equal((await as('vira', 'select id from public.categories')).length, categories.length);
  await rejects(as('vira', 'select * from public.admin_users()'), 'адміністратора');
  await rejects(as('vira', 'select public.admin_set_admin($1, true)', [users.vira]), 'адміністратора');
  await rejects(as('vira', 'select * from private.admins'), 'permission denied');

  // Адмін.
  await db.query('insert into private.admins (user_id) values ($1) on conflict do nothing', [users.anna]);
  assert.equal((await as('anna', 'select public.am_i_admin() as a'))[0].a, true);
  const [{ id: tagId }] = await as('anna', "insert into public.categories (name, icon) values ('Спорт', '⚽') returning id");
  await as('anna', "update public.categories set name = 'Спорт і фітнес' where id = $1", [tagId]);
  const all = await as('anna', 'select * from public.admin_users()');
  assert.equal(all.length, Object.keys(users).length);
  assert.equal(all.find((u) => u.id === users.anna).is_admin, true);
  await as('anna', 'select public.admin_set_admin($1, true)', [users.vira]);
  assert.equal((await as('vira', 'select public.am_i_admin() as a'))[0].a, true);
  await as('anna', 'select public.admin_set_admin($1, false)', [users.vira]);
  await rejects(as('anna', 'select public.admin_set_admin($1, false)', [users.anna]), 'із себе');

  // Витрата з тегом; видалення тегу не видаляє витрату.
  const [{ create_group: gid }] = await as('vira', 'select public.create_group($1)', ['Теги']);
  const share = JSON.stringify([{ user_id: users.vira, amount: 500 }]);
  const [{ add_expense: expId }] = await as('vira',
    'select public.add_expense(gid => $1, description => $2, amount => 500, paid_by => $3, shares => $4::jsonb, category_id => $5)',
    [gid, 'Абонемент', users.vira, share, tagId]);
  // Без тегу — як раніше (стара версія сайту).
  await as('vira', 'select public.add_expense(gid => $1, description => $2, amount => 500, paid_by => $3, shares => $4::jsonb)',
    [gid, 'Без тегу', users.vira, share]);
  await rejects(as('vira', 'select public.add_expense(gid => $1, description => $2, amount => 500, paid_by => $3, shares => $4::jsonb, category_id => -1)',
    [gid, 'X', users.vira, share]), 'Тег не знайдено');
  await as('anna', 'delete from public.categories where id = $1', [tagId]);
  const [row] = await as('vira', 'select category_id from public.expenses where id = $1', [expId]);
  assert.equal(row.category_id, null);
});

test('редагування витрати та історія змін', async () => {
  const [{ create_group: gid }] = await as('bohdan', 'select public.create_group($1)', ['Історія']);
  await as('bohdan', 'select public.add_group_member($1, $2)', [gid, 'vira@example.com']);
  const shares = (pairs) => JSON.stringify(pairs.map(([u, a]) => ({ user_id: users[u], amount: a })));
  const [{ add_expense: eid }] = await as('bohdan',
    'select public.add_expense(gid => $1, description => $2, amount => 1000, paid_by => $3, shares => $4::jsonb)',
    [gid, 'Піца', users.bohdan, shares([['bohdan', 500], ['vira', 500]])]);

  const edit = (who, amount, pairs, description = 'Піца велика') => as(who,
    'select public.update_expense(expense_id => $1, description => $2, amount => $3, paid_by => $4, shares => $5::jsonb, expense_date => null)',
    [eid, description, amount, users.bohdan, shares(pairs)]);

  // Інший учасник може редагувати; чужий — ні; перевірки ті самі, що й при додаванні.
  await edit('vira', 1200, [['bohdan', 400], ['vira', 800]]);
  await rejects(edit('stranger', 1200, [['bohdan', 1200]]), 'Витрату не знайдено');
  await rejects(edit('vira', 1200, [['bohdan', 100]]), 'Сума витрат учасників');
  const [e] = await as('vira', 'select amount, description from public.expenses where id = $1', [eid]);
  assert.equal(Number(e.amount), 1200);
  assert.equal(e.description, 'Піца велика');
  const shareRows = await as('vira', 'select user_id, amount from public.expense_shares where expense_id = $1 order by amount', [eid]);
  assert.deepEqual(shareRows.map((r) => Number(r.amount)), [400, 800]);

  // Без змін — у історію нічого не пишемо.
  await edit('vira', 1200, [['bohdan', 400], ['vira', 800]]);

  await as('bohdan', 'delete from public.expenses where id = $1', [eid]);
  const history = await as('vira', 'select action, changed_by, old_data, new_data from public.expense_history where group_id = $1 order by id', [gid]);
  assert.deepEqual(history.map((h) => h.action), ['created', 'updated', 'deleted']);
  assert.equal(history[1].changed_by, users.vira);
  assert.equal(history[1].old_data.amount, 1000);
  assert.equal(history[1].new_data.amount, 1200);
  assert.equal(history[2].old_data.description, 'Піца велика');
  assert.equal(history[2].old_data.shares.length, 2);

  // Історію бачать лише учасники й ніхто не може її підробити.
  assert.equal((await as('stranger', 'select * from public.expense_history where group_id = $1', [gid])).length, 0);
  await rejects(as('vira', "insert into public.expense_history (group_id, action) values ($1, 'created')", [gid]), 'permission denied');
  await rejects(as('vira', 'delete from public.expense_history'), 'permission denied');
});

test('порядок тегів змінює лише адмін', async () => {
  const ids = (await as('vira', 'select id from public.categories order by sort_order, id')).map((r) => r.id);
  const reversed = [...ids].reverse();
  await rejects(as('vira', 'select public.admin_reorder_categories($1)', [reversed]), 'адміністратора');
  await as('anna', 'select public.admin_reorder_categories(ids => $1)', [reversed]);
  const after = (await as('vira', 'select id from public.categories order by sort_order, id')).map((r) => r.id);
  assert.deepEqual(after, reversed);
});

test('група з витратами видаляється цілком (разом з історією)', async () => {
  const [{ create_group: gid }] = await as('vira', 'select public.create_group($1)', ['На видалення']);
  await as('vira', 'select public.add_expense(gid => $1, description => $2, amount => 100, paid_by => $3, shares => $4::jsonb)',
    [gid, 'x', users.vira, JSON.stringify([{ user_id: users.vira, amount: 100 }])]);
  await db.query('delete from public.groups where id = $1', [gid]);
  assert.equal((await db.query('select count(*)::int as n from public.expense_history where group_id = $1', [gid])).rows[0].n, 0);
});

test('фото квитанції: бачать і змінюють лише учасники групи', async () => {
  const [{ create_group: gid }] = await as('bohdan', 'select public.create_group($1)', ['Квитанції']);
  await as('bohdan', 'select public.add_group_member($1, $2)', [gid, 'vira@example.com']);
  const [{ add_expense: eid }] = await as('bohdan',
    'select public.add_expense(gid => $1, description => $2, amount => 500, paid_by => $3, shares => $4::jsonb)',
    [gid, 'Кава', users.bohdan, JSON.stringify([{ user_id: users.bohdan, amount: 500 }])]);
  const path = `${gid}/chek.jpg`;
  const upload = (who, name) => as(who, "insert into storage.objects (bucket_id, name) values ('receipts', $1)", [name]);

  // Завантажити файл можна лише в папку своєї групи.
  await upload('vira', path);
  await rejects(upload('stranger', `${gid}/x.jpg`), 'row-level security');
  await rejects(upload('vira', 'abc/x.jpg'), 'row-level security');
  assert.equal((await as('bohdan', "select * from storage.objects where bucket_id = 'receipts'")).length, 1);
  assert.equal((await as('stranger', "select * from storage.objects where bucket_id = 'receipts'")).length, 0);

  // Прикріпити до витрати: лише учасник і лише файл з папки цієї групи.
  const setReceipt = (who, p) => as(who, 'select public.set_expense_receipt(expense_id => $1, receipt_path => $2) as old', [eid, p]);
  await rejects(setReceipt('stranger', path), 'Витрату не знайдено');
  await rejects(setReceipt('vira', `${gid + 1}/chek.jpg`), 'Некоректний файл');
  assert.equal((await setReceipt('vira', path))[0].old, null);
  assert.equal((await as('bohdan', 'select receipt_path from public.expenses where id = $1', [eid]))[0].receipt_path, path);
  assert.equal((await setReceipt('bohdan', null))[0].old, path);

  // Напряму змінити витрату не можна — лише через функцію.
  await rejects(as('vira', 'update public.expenses set receipt_path = $1 where id = $2', [path, eid]), 'permission denied');
});

test('архів груп: лише розрахована група і лише для себе', async () => {
  const [{ create_group: gid }] = await as('anna', 'select public.create_group($1)', ['Архів']);
  await as('anna', 'select public.add_group_member($1, $2)', [gid, 'bohdan@example.com']);
  const archived = async (who) =>
    (await as(who, 'select archived from public.group_list() where id = $1', [gid]))[0].archived;
  const archive = (who, value) => as(who, 'select public.set_group_archived(gid => $1, archived => $2)', [gid, value]);

  await as('anna', 'select public.add_expense(gid => $1, description => $2, amount => 1000, paid_by => $3, shares => $4::jsonb)',
    [gid, 'Таксі', users.anna, JSON.stringify([{ user_id: users.anna, amount: 500 }, { user_id: users.bohdan, amount: 500 }])]);
  await rejects(archive('anna', true), 'всі розрахувалися');
  await rejects(archive('stranger', true), 'Групу не знайдено');

  await as('bohdan', 'insert into public.settlements (group_id, from_user, to_user, amount) values ($1, $2, $3, 500)',
    [gid, users.bohdan, users.anna]);
  await archive('anna', true);
  assert.equal(await archived('anna'), true);
  assert.equal(await archived('bohdan'), false); // в архіві лише в Анни
  assert.ok((await as('anna', 'select created_at from public.group_list() where id = $1', [gid]))[0].created_at);

  // Новий борг — група сама повертається до активних.
  await as('bohdan', 'select public.add_expense(gid => $1, description => $2, amount => 200, paid_by => $3, shares => $4::jsonb)',
    [gid, 'Кава', users.bohdan, JSON.stringify([{ user_id: users.anna, amount: 200 }])]);
  assert.equal(await archived('anna'), false);

  await archive('anna', false);
  assert.equal(await archived('anna'), false);
});

test('валюти: основна валюта групи, курси й витрати в іншій валюті', async () => {
  assert.ok((await as('anna', 'select code from public.currencies')).length >= 10);
  await rejects(as('anna', 'select public.create_group($1, $2)', ['X', 'ABC']), 'Невідома валюта');
  const [{ create_group: gid }] = await as('anna', 'select public.create_group(group_name => $1, group_currency => $2)', ['Польща', 'PLN']);
  assert.equal((await as('anna', 'select currency from public.groups where id = $1', [gid]))[0].currency, 'PLN');
  await as('anna', 'select public.add_group_member($1, $2)', [gid, 'bohdan@example.com']);

  const setRate = (who, cur, rate) => as(who, 'select public.set_group_rate(gid => $1, currency => $2, rate => $3)', [gid, cur, rate]);
  await rejects(setRate('anna', 'PLN', 1), 'основна валюта');
  await rejects(setRate('stranger', 'EUR', 4.3), 'Групу не знайдено');
  await rejects(setRate('anna', 'EUR', -1), 'Некоректний курс');
  await setRate('bohdan', 'EUR', 4.3);
  await setRate('anna', 'EUR', 4.25);
  assert.equal(Number((await as('bohdan', 'select rate from public.group_rates where group_id = $1', [gid]))[0].rate), 4.25);
  assert.equal((await as('stranger', 'select * from public.group_rates')).length, 0);
  await rejects(as('anna', 'insert into public.group_rates (group_id, currency, rate) values ($1, $2, 1)', [gid, 'USD']), 'permission denied');

  const add = (amount, currency, original) => as('anna',
    'select public.add_expense(gid => $1, description => $2, amount => $3, paid_by => $4, shares => $5::jsonb, expense_currency => $6, original_amount => $7)',
    [gid, 'Вечеря', amount, users.anna,
      JSON.stringify([{ user_id: users.anna, amount: amount - Math.floor(amount / 2) }, { user_id: users.bohdan, amount: Math.floor(amount / 2) }]),
      currency, original]);
  // 10 EUR × 4,25 = 42,50 PLN.
  await rejects(add(5000, 'EUR', 1000), 'Курс валюти змінився');
  await rejects(add(1000, 'USD', 1000), 'не задано курс');
  const [{ add_expense: eid }] = await add(4250, 'EUR', 1000);
  const [row] = await as('bohdan', 'select currency, original_amount, rate, amount from public.expenses where id = $1', [eid]);
  assert.deepEqual([row.currency, Number(row.original_amount), Number(row.rate), Number(row.amount)], ['EUR', 1000, 4.25, 4250]);
  // В основній валюті — без курсу.
  const [{ add_expense: plain }] = await add(300, 'PLN', 300);
  assert.equal((await as('anna', 'select currency from public.expenses where id = $1', [plain]))[0].currency, null);

  // Редагування в тій самій валюті зберігає старий курс, навіть якщо курс групи змінився.
  await setRate('anna', 'EUR', 5);
  const update = (amount, original) => as('anna',
    'select public.update_expense(expense_id => $1, description => $2, amount => $3, paid_by => $4, shares => $5::jsonb, expense_date => $6, expense_currency => $7, original_amount => $8)',
    [eid, 'Вечеря', amount, users.anna, JSON.stringify([{ user_id: users.anna, amount }]), '2026-09-01', 'EUR', original]);
  await update(8500, 2000); // 20 EUR × 4,25
  assert.equal(Number((await as('anna', 'select rate from public.expenses where id = $1', [eid]))[0].rate), 4.25);
  await rejects(update(10000, 2000), 'Курс валюти змінився');
});

test('валюта за замовчуванням: змінює лише адмін', async () => {
  await db.query('insert into private.admins (user_id) values ($1) on conflict do nothing', [users.anna]);
  const current = async () => (await as('bohdan', 'select default_currency from public.app_settings'))[0].default_currency;
  assert.equal(await current(), 'UAH');
  await rejects(as('bohdan', 'select public.admin_set_default_currency($1)', ['EUR']), 'адміністратора');
  await rejects(as('anna', 'select public.admin_set_default_currency($1)', ['XXX']), 'Невідома валюта');
  await rejects(as('anna', 'update public.app_settings set default_currency = $1', ['EUR']), 'permission denied');
  await as('anna', 'select public.admin_set_default_currency(currency => $1)', ['EUR']);
  assert.equal(await current(), 'EUR');
  await as('anna', 'select public.admin_set_default_currency($1)', ['UAH']);
});

test('дизайн застосунку: перемикає лише адмін', async () => {
  await db.query('insert into private.admins (user_id) values ($1) on conflict do nothing', [users.anna]);
  const current = async () => (await as('vira', 'select design from public.app_settings'))[0].design;
  assert.equal(await current(), 'dark'); // вибір, зроблений до міграції 021, зберігається
  await rejects(as('bohdan', 'select public.admin_set_design($1)', ['dark']), 'адміністратора');
  await rejects(as('anna', 'select public.admin_set_design($1)', ['pink']), 'Невідомий дизайн');
  // Прибрані дизайни більше не приймаються.
  await rejects(as('anna', 'select public.admin_set_design($1)', ['mono']), 'Невідомий дизайн');
  await rejects(as('anna', 'select public.admin_set_design($1)', ['paper']), 'Невідомий дизайн');
  await as('anna', 'select public.admin_set_design(design => $1)', ['dark']);
  assert.equal(await current(), 'dark');
  await as('anna', 'select public.admin_set_design($1)', ['nova']);
  assert.equal(await current(), 'nova');
});

test('до витрати можна прикріпити 2 фото', async () => {
  const [{ create_group: gid }] = await as('bohdan', 'select public.create_group($1)', ['Два фото']);
  const [{ add_expense: eid }] = await as('bohdan',
    'select public.add_expense(gid => $1, description => $2, amount => 100, paid_by => $3, shares => $4::jsonb)',
    [gid, 'Чай', users.bohdan, JSON.stringify([{ user_id: users.bohdan, amount: 100 }])]);
  const setPhoto = (who, slot, p) => as(who, 'select public.set_expense_photo(expense_id => $1, slot => $2, photo_path => $3) as old', [eid, slot, p]);
  assert.equal((await setPhoto('bohdan', 1, `${gid}/a.jpg`))[0].old, null);
  assert.equal((await setPhoto('bohdan', 2, `${gid}/b.jpg`))[0].old, null);
  await rejects(setPhoto('bohdan', 3, `${gid}/c.jpg`), 'не більше 2');
  await rejects(setPhoto('stranger', 2, `${gid}/c.jpg`), 'Витрату не знайдено');
  await rejects(setPhoto('bohdan', 2, `${gid + 1}/c.jpg`), 'Некоректний файл');
  const [row] = await as('bohdan', 'select receipt_path, receipt_path2 from public.expenses where id = $1', [eid]);
  assert.deepEqual([row.receipt_path, row.receipt_path2], [`${gid}/a.jpg`, `${gid}/b.jpg`]);
  assert.equal((await setPhoto('bohdan', 2, null))[0].old, `${gid}/b.jpg`);
});

test('брендинг і SEO: змінює лише адмін, читати можуть усі', async () => {
  await db.query('insert into private.admins (user_id) values ($1) on conflict do nothing', [users.anna]);
  const meta = async (who) => (await as(who, 'select * from public.site_meta()'))[0];
  assert.match((await meta(null)).site_title, /Спільні витрати/);
  const setBranding = (who, title, logo) => as(who,
    'select * from public.admin_set_branding(site_title => $1, site_description => $2, logo_path => $3, og_image_path => $4)',
    [title, 'Опис', logo, null]);
  await rejects(setBranding('bohdan', 'X', null), 'адміністратора');
  await rejects(setBranding('anna', '  ', null), 'Назва сайту');
  assert.equal((await setBranding('anna', 'Мій сайт', 'logo-1.png'))[0].old_logo_path, null);
  assert.equal((await setBranding('anna', 'Мій сайт', 'logo-2.png'))[0].old_logo_path, 'logo-1.png');
  assert.equal((await meta(null)).logo_path, 'logo-2.png');
  await rejects(setBranding('anna', 'Мій сайт', '../x.png'), 'app_settings_site_check');

  // Файли в сховище branding завантажує лише адмін.
  const upload = (who, name) => as(who, "insert into storage.objects (bucket_id, name) values ('branding', $1)", [name]);
  await upload('anna', 'logo-3.png');
  await rejects(upload('bohdan', 'evil.png'), 'row-level security');
});

test('окремий логотип для кожного дизайну', async () => {
  await db.query('insert into private.admins (user_id) values ($1) on conflict do nothing', [users.anna]);
  const setLogo = (who, design, path) => as(who,
    'select public.admin_set_design_logo(design => $1, logo_path => $2) as old', [design, path]);
  const logos = async () => (await as(null, 'select public.site_logos() as l'))[0].l;
  await rejects(setLogo('bohdan', 'dark', 'x.png'), 'адміністратора');
  await rejects(setLogo('anna', 'pink', 'x.png'), 'Невідомий дизайн');
  await rejects(setLogo('anna', 'dark', '../x.png'), 'Некоректний файл');

  assert.equal((await setLogo('anna', 'dark', 'dark-1.png'))[0].old, null);
  await rejects(setLogo('anna', 'paper', 'x.png'), 'Невідомий дизайн');
  await setLogo('anna', 'nova', 'nova-1.png');
  assert.deepEqual(await logos(), { dark: 'dark-1.png', nova: 'nova-1.png' });
  // Заміна: старий файл повертається для видалення, лише якщо ним більше ніхто не користується.
  assert.equal((await setLogo('anna', 'dark', 'shared.png'))[0].old, 'dark-1.png');
  assert.equal((await setLogo('anna', 'nova', 'shared.png'))[0].old, 'nova-1.png');
  assert.equal((await setLogo('anna', 'dark', null))[0].old, null); // shared.png ще в nova
  assert.equal((await setLogo('anna', 'nova', null))[0].old, 'shared.png');
  assert.deepEqual(await logos(), {});
});

test('власний дизайн користувача: змінює лише свій', async () => {
  await as('vira', "update public.profiles set design = 'nova' where id = $1", [users.vira]);
  assert.equal((await as('vira', 'select design from public.profiles where id = $1', [users.vira]))[0].design, 'nova');
  await as('vira', "update public.profiles set design = 'dark' where id = $1", [users.vira]);
  assert.equal((await as('vira', 'select design from public.profiles where id = $1', [users.vira]))[0].design, 'dark');
  await rejects(as('vira', "update public.profiles set design = 'pink' where id = $1", [users.vira]), 'profiles_design_check');
  await rejects(as('vira', "update public.profiles set design = 'paper' where id = $1", [users.vira]), 'profiles_design_check');
  // Чужий профіль не змінюється (RLS просто не знаходить рядок).
  await as('vira', "update public.profiles set design = 'dark' where id = $1", [users.anna]);
  assert.notEqual((await db.query('select design from public.profiles where id = $1', [users.anna])).rows[0].design, 'dark');
  await as('vira', 'update public.profiles set design = null where id = $1', [users.vira]);
});

test('видалення групи: лише автор і лише без витрат', async () => {
  const [{ create_group: gid }] = await as('anna', 'select public.create_group($1)', ['Порожня']);
  await as('anna', 'select public.add_group_member($1, $2)', [gid, 'bohdan@example.com']);
  const del = (who) => as(who, 'select public.delete_group(gid => $1)', [gid]);
  await rejects(del('stranger'), 'Групу не знайдено');
  await rejects(del('bohdan'), 'лише її автор');

  // З витратою видалити не можна.
  const [{ add_expense: eid }] = await as('anna',
    'select public.add_expense(gid => $1, description => $2, amount => 100, paid_by => $3, shares => $4::jsonb)',
    [gid, 'Кава', users.anna, JSON.stringify([{ user_id: users.anna, amount: 100 }])]);
  await rejects(del('anna'), 'вже є витрати');
  await as('anna', 'delete from public.expenses where id = $1', [eid]);

  // З поверненням боргу — теж ні.
  await as('anna', 'insert into public.settlements (group_id, from_user, to_user, amount) values ($1, $2, $3, 100)', [gid, users.anna, users.bohdan]);
  await rejects(del('anna'), 'вже є витрати');
  await as('anna', 'delete from public.settlements where group_id = $1', [gid]);

  await del('anna');
  assert.equal((await db.query('select count(*)::int as n from public.groups where id = $1', [gid])).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int as n from public.group_members where group_id = $1', [gid])).rows[0].n, 0);
});

test('Telegram: прив\'язка через бота і сповіщення про нову витрату', async () => {
  // Замість pg_net — запис запитів у таблицю.
  await db.exec(`
    create schema if not exists net;
    create table if not exists net.sent (url text, body jsonb);
    create or replace function net.http_post(url text, body jsonb, headers jsonb) returns bigint language sql as
      $$ insert into net.sent values (url, body); select 1::bigint $$;
    grant usage on schema net to authenticated;
    grant insert on net.sent to authenticated;
  `);
  const webhook = async (secret, text, chatId = 555) => (await db.query(
    'select public.telegram_webhook($1, $2::jsonb) as r',
    [secret, JSON.stringify({ message: { chat: { id: chatId, type: 'private' }, text } })],
  )).rows[0].r;

  // Поки бота не налаштовано — у профілі нічого не показуємо, посилання не видаємо.
  assert.deepEqual(await as('bohdan', 'select * from public.telegram_status()'), []);
  await rejects(as('bohdan', 'select public.telegram_link_start()'), 'ще не налаштовано');

  await db.query("select private.telegram_setup('123:ABC', '@spilni_bot', 'https://example.com/hook')");
  const [{ webhook_secret: secret }] = (await db.query('select webhook_secret from private.telegram_bot')).rows;
  const hook = (await db.query("select body from net.sent where url like '%/setWebhook'")).rows[0].body;
  assert.equal(hook.secret_token, secret);
  assert.equal(hook.url, 'https://example.com/hook');

  // Токен і прив'язки не видно через API, вебхук не викликати звичайному користувачу.
  await rejects(as('bohdan', 'select * from private.telegram_bot'), 'permission denied');
  await rejects(as('bohdan', "select public.telegram_webhook('x', '{}'::jsonb)"), 'permission denied');
  await rejects(webhook('wrong', '/start abc'), 'forbidden');

  const [{ telegram_link_start: link }] = await as('bohdan', 'select public.telegram_link_start()');
  assert.match(link, /^https:\/\/t\.me\/spilni_bot\?start=[0-9a-f]{32}$/);
  const code = link.split('=')[1];
  assert.match((await webhook(secret, `/start ${code}`)).text, /Готово, Богдан/);
  assert.match((await webhook(secret, `/start ${code}`)).text, /застаріло/); // код одноразовий
  assert.deepEqual(await as('bohdan', 'select * from public.telegram_status()'), [{ bot_username: 'spilni_bot', linked: true }]);

  // Анна додає витрату — Богдан отримує повідомлення; Анна Telegram не підключала, чужі групи — ні.
  await db.exec('delete from net.sent');
  const [{ create_group: gid }] = await as('anna', 'select public.create_group($1)', ['Відпустка']);
  await as('anna', 'select public.add_group_member($1, $2)', [gid, 'bohdan@example.com']);
  await as('anna',
    'select public.add_expense(gid => $1, description => $2, amount => 123456, paid_by => $3, shares => $4::jsonb)',
    [gid, 'Готель', users.anna, JSON.stringify([{ user_id: users.anna, amount: 61728 }, { user_id: users.bohdan, amount: 61728 }])]);
  const sent = (await db.query('select url, body from net.sent')).rows;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://api.telegram.org/bot123:ABC/sendMessage');
  assert.equal(sent[0].body.chat_id, 555);
  const today = (await db.query("select to_char(current_date, 'DD.MM.YYYY') as d")).rows[0].d;
  assert.equal(sent[0].body.text,
    '💸 <b>Нова витрата</b> · Відпустка\n\n🧾 <b>Готель</b>\n💰 <b>1 234,56 грн</b>\n👤 Заплатив(ла): <b>Ганна</b>\n'
    + `📅 ${today}\n\n<blockquote>🫵 Ваша витрата: <b>617,28 грн</b></blockquote>\n`
    + '🔴 Ваш баланс у групі: <b>−617,28 грн</b> — ви винні');
  assert.equal(sent[0].body.parse_mode, 'HTML');
  const [{ id: eid }] = (await db.query('select id from public.expenses where group_id = $1', [gid])).rows;
  assert.deepEqual(sent[0].body.reply_markup, { inline_keyboard: [[
    { text: '🧾 Відкрити витрату', url: `https://finance.chinnect24.com/#/groups/${gid}/expenses/${eid}` },
    { text: '📂 Група', url: `https://finance.chinnect24.com/#/groups/${gid}` },
  ]] });

  // /stop і кнопка «Відключити» вимикають сповіщення.
  assert.match((await webhook(secret, '/stop')).text, /вимкнено/);
  assert.deepEqual(await as('bohdan', 'select * from public.telegram_status()'), [{ bot_username: 'spilni_bot', linked: false }]);
  await db.exec('delete from net.sent');
  await as('anna',
    'select public.add_expense(gid => $1, description => $2, amount => 100, paid_by => $3, shares => $4::jsonb)',
    [gid, 'Кава', users.anna, JSON.stringify([{ user_id: users.anna, amount: 100 }])]);
  assert.equal((await db.query('select count(*)::int as n from net.sent')).rows[0].n, 0);
});

test('Telegram: сповіщення з фото квитанцій через функцію notify-telegram', async () => {
  const [{ webhook_secret: secret }] = (await db.query('select webhook_secret from private.telegram_bot')).rows;
  const [{ telegram_link_start: link }] = await as('bohdan', 'select public.telegram_link_start()');
  await db.query('select public.telegram_webhook($1, $2::jsonb)',
    [secret, JSON.stringify({ message: { chat: { id: 555, type: 'private' }, text: `/start ${link.split('=')[1]}` } })]);

  // Адресу функції вмикає лише адмін бази; після цього база лише «штовхає» функцію номером витрати.
  await rejects(as('bohdan', "select private.telegram_notify_setup('https://evil.example')"), 'permission denied');
  await db.query("select private.telegram_notify_setup('https://example.com/functions/v1/notify-telegram')");
  await db.exec('delete from net.sent');
  const [{ create_group: gid }] = await as('anna', 'select public.create_group($1)', ['Кафе']);
  await as('anna', 'select public.add_group_member($1, $2)', [gid, 'bohdan@example.com']);
  const [{ add_expense: eid }] = await as('anna',
    'select public.add_expense(gid => $1, description => $2, amount => 5000, paid_by => $3, shares => $4::jsonb, note => $5)',
    [gid, 'Обід', users.anna, JSON.stringify([{ user_id: users.anna, amount: 2500 }, { user_id: users.bohdan, amount: 2500 }]), 'Чек <у чаті>']);
  const sent = (await db.query("select url, body from net.sent where url not like '%notify-expense'")).rows;
  assert.deepEqual(sent, [{ url: 'https://example.com/functions/v1/notify-telegram', body: { expense_id: eid } }]);

  // Фото прикріпили після створення — функція отримує їх разом із текстами й кнопками.
  await as('anna', 'select public.set_expense_photo($1, 1, $2)', [eid, `${gid}/a.jpg`]);
  await as('anna', 'select public.set_expense_photo($1, 2, $2)', [eid, `${gid}/b.jpg`]);
  await rejects(as('bohdan', 'select public.telegram_expense_notification($1, $2)', [secret, eid]), 'permission denied');
  await rejects(db.query('select public.telegram_expense_notification($1, $2)', ['wrong', eid]), 'forbidden');
  const [{ n }] = (await db.query('select public.telegram_expense_notification($1, $2) as n', [secret, eid])).rows;
  assert.equal(n.token, '123:ABC');
  assert.deepEqual(n.photos, [`${gid}/a.jpg`, `${gid}/b.jpg`]);
  assert.equal(n.buttons.inline_keyboard[0][0].url, `https://finance.chinnect24.com/#/groups/${gid}/expenses/${eid}`);
  assert.equal(n.messages.length, 1);
  assert.equal(n.messages[0].chat_id, 555);
  assert.match(n.messages[0].text, /^💸 <b>Нова витрата<\/b> · Кафе\n/);
  assert.match(n.messages[0].text, /\n💬 <i>Чек &lt;у чаті&gt;<\/i>\n\n<blockquote>🫵 Ваша витрата: <b>25,00 грн<\/b>/);

  // Авторка витрати з підключеним Telegram теж отримує повідомлення — як підтвердження.
  const [{ telegram_link_start: annaLink }] = await as('anna', 'select public.telegram_link_start()');
  await db.query('select public.telegram_webhook($1, $2::jsonb)',
    [secret, JSON.stringify({ message: { chat: { id: 777, type: 'private' }, text: `/start ${annaLink.split('=')[1]}` } })]);
  const [{ n: both }] = (await db.query('select public.telegram_expense_notification($1, $2) as n', [secret, eid])).rows;
  const anna = both.messages.find((m) => m.chat_id === 777);
  assert.equal(both.messages.length, 2);
  assert.match(anna.text, /^✅ <b>Ви додали витрату<\/b> · Кафе\n/);
  assert.match(anna.text, /<blockquote>🫵 Ваша витрата: <b>25,00 грн<\/b>/);
  assert.doesNotMatch(anna.text, /Додав\(ла\)/);

  await db.query("select private.telegram_notify_setup('')");
  assert.equal((await db.query('select notify_url from private.telegram_bot')).rows[0].notify_url, null);
});

test('Пошта: сповіщення про нову витрату лише тим, хто ввімкнув', async () => {
  // net.http_post уже підмінено в тесті Telegram (запис у net.sent).
  await db.exec('delete from net.sent');
  const [{ create_group: gid }] = await as('anna', 'select public.create_group($1)', ['Дача']);
  await as('anna', 'select public.add_group_member($1, $2)', [gid, 'bohdan@example.com']);
  await as('anna', 'select public.add_group_member($1, $2)', [gid, 'vira@example.com']);
  const addExpense = () => as('anna',
    'select public.add_expense(gid => $1, description => $2, amount => 30000, paid_by => $3, shares => $4::jsonb)',
    [gid, 'Дрова', users.bohdan, JSON.stringify([{ user_id: users.anna, amount: 15000 }, { user_id: users.bohdan, amount: 15000 }])]);
  const mailSent = async () => (await db.query("select body from net.sent where url like '%notify-expense'")).rows;

  // Поки функцію не налаштовано — нічого не надсилаємо.
  await as('bohdan', 'update public.profiles set notify_expense_email = true where id = $1', [users.bohdan]);
  await addExpense();
  assert.deepEqual(await mailSent(), []);

  // Налаштування й секрет не видно через API; чужий профіль не змінити.
  await db.query("select private.email_notify_setup('https://example.com/functions/v1/notify-expense', 's3cret')");
  await rejects(as('bohdan', 'select * from private.email_notify'), 'permission denied');
  await rejects(as('bohdan', "select private.email_notify_setup('https://evil.example', 'x')"), 'permission denied');
  await as('bohdan', 'update public.profiles set notify_expense_email = true where id = $1', [users.vira]);
  assert.equal((await db.query('select notify_expense_email from public.profiles where id = $1', [users.vira])).rows[0].notify_expense_email, false);

  // Анна додає витрату — лист лише Богдану (Віра не вмикала, Анна — авторка).
  await addExpense();
  const [first, ...rest] = await mailSent();
  assert.equal(rest.length, 0);
  assert.deepEqual(first.body.recipients, [{ email: 'Bohdan@Example.com', name: 'Богдан', share: '150,00 грн' }]);
  assert.equal(first.body.group_name, 'Дача');
  assert.equal(first.body.group_id, gid);
  assert.equal(first.body.amount, '300,00 грн');
  assert.equal(first.body.payer, 'Богдан');
  assert.equal(first.body.author, 'Ганна');

  // Вимкнув — більше листів немає.
  await db.exec('delete from net.sent');
  await as('bohdan', 'update public.profiles set notify_expense_email = false where id = $1', [users.bohdan]);
  await addExpense();
  assert.deepEqual(await mailSent(), []);
});

test('Telegram: баланс у повідомленні й екранування HTML', async () => {
  const one = async (sql) => (await db.query(sql)).rows[0].v;
  assert.equal(await one("select private.telegram_html('A&B <i>') as v"), 'A&amp;B &lt;i&gt;');
  assert.equal(await one("select private.telegram_balance_line(150000, 'UAH') as v"), '🟢 Ваш баланс у групі: <b>+1 500,00 грн</b> — вам винні');
  assert.equal(await one("select private.telegram_balance_line(-5, 'USD') as v"), '🔴 Ваш баланс у групі: <b>−0,05 USD</b> — ви винні');
  assert.equal(await one("select private.telegram_balance_line(0, 'UAH') as v"), '⚪️ Ваш баланс у групі: <b>0,00 грн</b> — усе сплачено');
});

test('перегляди витрати: автор уже бачив, учасники позначають, чужі — ні', async () => {
  const [{ create_group: gid }] = await as('anna', 'select public.create_group($1)', ['Перегляди']);
  await as('anna', 'select public.add_group_member($1, $2)', [gid, 'bohdan@example.com']);
  const [{ add_expense: eid }] = await as('anna',
    'select public.add_expense(gid => $1, description => $2, amount => 100, paid_by => $3, shares => $4::jsonb)',
    [gid, 'Чай', users.anna, JSON.stringify([{ user_id: users.anna, amount: 100 }])]);
  const viewers = async (who) => (await as(who, 'select user_id from public.expense_views where expense_id = $1', [eid]))
    .map((r) => r.user_id).sort();
  assert.deepEqual(await viewers('bohdan'), [users.anna]);
  await as('bohdan', 'select public.mark_expense_viewed($1)', [eid]);
  await as('bohdan', 'select public.mark_expense_viewed(eid => $1)', [eid]); // повторно — без помилки
  assert.deepEqual(await viewers('anna'), [users.anna, users.bohdan].sort());
  await rejects(as('stranger', 'select public.mark_expense_viewed($1)', [eid]), 'Витрату не знайдено');
  assert.deepEqual(await viewers('stranger'), []);
  await rejects(as('bohdan', 'insert into public.expense_views (expense_id, user_id) values ($1, $2)', [eid, users.vira]), 'permission denied');
});

test('валюта для нових витрат у групі: основна або з курсом, змінює учасник', async () => {
  const [{ create_group: gid }] = await as('anna', 'select public.create_group($1)', ['Бухарест']);
  await as('anna', 'select public.add_group_member($1, $2)', [gid, 'bohdan@example.com']);
  const current = async () => (await as('anna', 'select expense_currency from public.groups where id = $1', [gid]))[0].expense_currency;
  const setDefault = (who, cur) => as(who, 'select public.set_group_expense_currency(gid => $1, currency => $2)', [gid, cur]);
  assert.equal(await current(), null);
  await rejects(setDefault('bohdan', 'EUR'), 'Спершу додайте курс');
  await as('anna', 'select public.set_group_rate(gid => $1, currency => $2, rate => $3)', [gid, 'EUR', 45]);
  await setDefault('bohdan', 'EUR');
  assert.equal(await current(), 'EUR');
  await rejects(setDefault('stranger', 'EUR'), 'Групу не знайдено');
  await rejects(as('bohdan', 'update public.groups set expense_currency = null where id = $1', [gid]), 'permission denied');
  // Прибрали курс — знову основна валюта; обрати основну — те саме, що null.
  await as('anna', 'select public.set_group_rate(gid => $1, currency => $2, rate => $3)', [gid, 'EUR', null]);
  assert.equal(await current(), null);
  await setDefault('anna', 'UAH');
  assert.equal(await current(), null);
});

test('фото з Google: береться під час реєстрації, власне фото чи видалення його прибирає', async () => {
  const photo = 'https://lh3.googleusercontent.com/a/abc=s96-c';
  const { rows: [{ id }] } = await db.query(
    'insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id',
    ['gmail@example.com', { name: 'Гугл', avatar_url: photo }]);
  users.google = id;
  const profile = async () => (await as('google', 'select avatar_path, photo_url from public.profiles where id = $1', [id]))[0];
  assert.deepEqual(await profile(), { avatar_path: null, photo_url: photo });
  // Завантажив своє фото — Google-фото більше не показуємо.
  await as('google', 'update public.profiles set avatar_path = $1 where id = $2', [`${id}/1.jpg`, id]);
  assert.deepEqual(await profile(), { avatar_path: `${id}/1.jpg`, photo_url: null });
  // Сам змінити photo_url не може.
  await rejects(as('google', 'update public.profiles set photo_url = $1 where id = $2', [photo, id]), 'permission denied');

  // Акаунт з пошти, потім уперше увійшов через Google — фото підставляється; «Видалити фото» його прибирає.
  await signUp('linked', 'linked@example.com', 'Пошта');
  const linked = async () => (await db.query('select photo_url from public.profiles where id = $1', [users.linked])).rows[0].photo_url;
  assert.equal(await linked(), null);
  await db.query('update auth.users set raw_user_meta_data = $1 where id = $2', [{ name: 'Пошта', picture: photo }, users.linked]);
  assert.equal(await linked(), photo);
  await as('linked', 'update public.profiles set avatar_path = null where id = $1', [users.linked]);
  assert.equal(await linked(), null);
  // Наступний вхід через Google фото не повертає.
  await db.query('update auth.users set raw_user_meta_data = $1 where id = $2', [{ name: 'Пошта', picture: photo + '2' }, users.linked]);
  assert.equal(await linked(), null);
});

test('коментар до витрати й повернення боргу: необов\'язковий, зберігається й редагується', async () => {
  const [{ create_group: gid }] = await as('anna', 'select public.create_group($1)', ['Коментарі']);
  await as('anna', 'select public.add_group_member($1, $2)', [gid, 'bohdan@example.com']);
  const shares = JSON.stringify([{ user_id: users.bohdan, amount: 500 }]);
  const [{ add_expense: plain }] = await as('anna', 'select public.add_expense(gid => $1, description => $2, amount => 500, paid_by => $3, shares => $4)',
    [gid, 'Таксі', users.anna, shares]);
  const [{ add_expense: eid }] = await as('anna', 'select public.add_expense(gid => $1, description => $2, amount => 500, paid_by => $3, shares => $4, note => $5)',
    [gid, 'Таксі', users.anna, shares, '  Поверне в п\'ятницю  ']);
  const note = async (id) => (await as('bohdan', 'select note from public.expenses where id = $1', [id]))[0].note;
  assert.equal(await note(plain), null);
  assert.equal(await note(eid), 'Поверне в п\'ятницю');
  await as('bohdan', 'select public.update_expense(expense_id => $1, description => $2, amount => 500, paid_by => $3, shares => $4, expense_date => null, note => $5)',
    [eid, 'Таксі', users.anna, shares, ' ']);
  assert.equal(await note(eid), null);
  const [h] = await as('anna', "select old_data ->> 'note' as old from public.expense_history where expense_id = $1 and action = 'updated'", [eid]);
  assert.equal(h.old, 'Поверне в п\'ятницю');
  await rejects(as('anna', 'select public.add_expense(gid => $1, description => $2, amount => 500, paid_by => $3, shares => $4, note => $5)',
    [gid, 'Таксі', users.anna, shares, 'x'.repeat(501)]), 'expenses_note_check');
  const [s] = await as('bohdan', 'insert into public.settlements (group_id, from_user, to_user, amount, note) values ($1, $2, $3, 500, $4) returning note',
    [gid, users.bohdan, users.anna, 'Готівкою']);
  assert.equal(s.note, 'Готівкою');
});

test('баланси в базі (список груп) збігаються з розрахунком на сайті; повернення боргу — в історії', async () => {
  const { computeBalances } = await import('../public/balances.js');
  const [{ create_group: gid }] = await as('anna', 'select public.create_group($1)', ['Звірка']);
  await as('anna', 'select public.add_group_member($1, $2)', [gid, 'bohdan@example.com']);
  await as('anna', 'select public.add_group_member($1, $2)', [gid, 'vira@example.com']);
  await as('anna', 'select public.set_group_rate(gid => $1, currency => $2, rate => $3)', [gid, 'EUR', 45.5]);
  const add = (who, payer, amount, shares, extra = '') => as(who,
    `select public.add_expense(gid => $1, description => 'x', amount => $2, paid_by => $3, shares => $4${extra})`,
    [gid, amount, users[payer], JSON.stringify(shares.map(([u, a]) => ({ user_id: users[u], amount: a })))]);
  await add('anna', 'anna', 10000, [['anna', 3334], ['bohdan', 3333], ['vira', 3333]]);
  await add('bohdan', 'bohdan', 45546, [['anna', 15152], ['bohdan', 30394]], ", expense_currency => 'EUR', original_amount => 1001");
  await add('vira', 'anna', 25050, [['vira', 25050]]); // борг: Віра винна Анні
  await as('vira', 'insert into public.settlements (group_id, from_user, to_user, amount) values ($1, $2, $3, 7000)', [gid, users.vira, users.anna]);
  const [{ id: sid }] = await as('bohdan', 'insert into public.settlements (group_id, from_user, to_user, amount) values ($1, $2, $3, 100) returning id', [gid, users.bohdan, users.anna]);
  await as('anna', 'delete from public.settlements where id = $1', [sid]);

  const expenses = (await as('anna', 'select id, paid_by, amount from public.expenses where group_id = $1', [gid]));
  const shares = await as('anna', 'select s.expense_id, s.user_id, s.amount from public.expense_shares s join public.expenses e on e.id = s.expense_id where e.group_id = $1', [gid]);
  const settlements = await as('anna', 'select from_user, to_user, amount from public.settlements where group_id = $1', [gid]);
  const site = computeBalances(['anna', 'bohdan', 'vira'].map((k) => users[k]),
    expenses.map((e) => ({ paidBy: e.paid_by, amount: Number(e.amount),
      shares: shares.filter((s) => s.expense_id === e.id).map((s) => ({ userId: s.user_id, amount: Number(s.amount) })) })),
    settlements.map((s) => ({ fromUser: s.from_user, toUser: s.to_user, amount: Number(s.amount) })));
  for (const who of ['anna', 'bohdan', 'vira']) {
    const [row] = await as(who, 'select my_balance from public.my_groups() where id = $1', [gid]);
    assert.equal(Number(row.my_balance), site.get(users[who]), who);
  }
  assert.equal(site.get(users.anna), 10000 - 3334 + 25050 - 15152 - 7000);

  const log = await as('bohdan', "select action, changed_by, coalesce(new_data, old_data) ->> 'amount' as amount from public.expense_history where group_id = $1 and action in ('settled', 'unsettled') order by id", [gid]);
  assert.deepEqual(log.map((r) => [r.action, r.changed_by, r.amount]), [
    ['settled', users.vira, '7000'], ['settled', users.bohdan, '100'], ['unsettled', users.anna, '100'],
  ]);
  await rejects(as('anna', "insert into public.expense_history (group_id, action) values ($1, 'settled')", [gid]), 'permission denied');
  // Видалення групи цілком (як під час очищення бази) не ламається через запис в історію.
  await db.query('delete from public.expenses where group_id = $1', [gid]);
  await db.query('delete from public.groups where id = $1', [gid]);
});
