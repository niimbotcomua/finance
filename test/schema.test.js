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
  await rejects(edit('vira', 1200, [['bohdan', 100]]), 'Сума часток');
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
