import express from 'express';
import { fileURLToPath } from 'node:url';
import { openDb, transaction } from './db.js';
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  hashPassword,
  parseCookies,
  userForSession,
  verifyPassword,
} from './auth.js';
import { computeBalances, simplifyDebts, splitEqually } from './balances.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_AMOUNT = 1_000_000_000_00; // 1 млрд грн у копійках

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new HttpError(status, message);
};

function requireString(value, field, { max = 200 } = {}) {
  if (typeof value !== 'string' || !value.trim()) fail(400, `Поле «${field}» обов'язкове`);
  const trimmed = value.trim();
  if (trimmed.length > max) fail(400, `Поле «${field}» задовге (максимум ${max} символів)`);
  return trimmed;
}

function requireAmount(value, field = 'сума') {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_AMOUNT) {
    fail(400, `Некоректна ${field}`);
  }
  return value;
}

function requireId(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) fail(400, `Некоректний ідентифікатор: ${field}`);
  return id;
}

function normalizeDate(value) {
  if (value === undefined || value === null || value === '') return new Date().toISOString().slice(0, 10);
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    fail(400, 'Некоректна дата');
  }
  return value;
}

export function createApp({ dbPath = ':memory:', trustProxy = false } = {}) {
  const db = openDb(dbPath);
  const app = express();
  app.set('trust proxy', trustProxy);
  app.disable('x-powered-by');
  app.locals.db = db;

  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(PUBLIC_DIR));

  // Поточний користувач із cookie сесії.
  app.use('/api', (req, _res, next) => {
    req.sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    req.user = userForSession(db, req.sessionToken);
    next();
  });

  // Базовий захист від CSRF: змінюючі запити мають бути JSON.
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return next(new HttpError(415, 'Очікується Content-Type: application/json'));
    }
    next();
  });

  const requireUser = (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Потрібно увійти'));
    next();
  };

  const setSessionCookie = (req, res, userId) => {
    const { token, maxAge } = createSession(db, userId);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge,
      path: '/',
    });
  };

  // ---------- Автентифікація ----------

  app.post('/api/auth/register', (req, res) => {
    const email = requireString(req.body?.email, 'email').toLowerCase();
    const name = requireString(req.body?.name, "ім'я", { max: 80 });
    const password = req.body?.password;
    if (!EMAIL_RE.test(email)) fail(400, 'Некоректний email');
    if (typeof password !== 'string' || password.length < 8) fail(400, 'Пароль має містити щонайменше 8 символів');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'Користувач з таким email вже існує');

    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
      .run(email, name, hashPassword(password));
    const userId = Number(lastInsertRowid);
    setSessionCookie(req, res, userId);
    res.status(201).json({ user: { id: userId, email, name } });
  });

  app.post('/api/auth/login', (req, res) => {
    const email = requireString(req.body?.email, 'email').toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const row = db.prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?').get(email);
    if (!row || !verifyPassword(password, row.password_hash)) fail(401, 'Невірний email або пароль');
    setSessionCookie(req, res, row.id);
    res.json({ user: { id: row.id, email: row.email, name: row.name } });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionToken) destroySession(db, req.sessionToken);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/me', requireUser, (req, res) => {
    res.json({ user: req.user });
  });

  // ---------- Групи ----------

  const loadGroup = (req, _res, next) => {
    const groupId = requireId(req.params.groupId, 'група');
    const group = db
      .prepare(
        `SELECT g.id, g.name, g.currency, g.created_by AS createdBy, g.created_at AS createdAt
         FROM groups g JOIN group_members m ON m.group_id = g.id
         WHERE g.id = ? AND m.user_id = ?`,
      )
      .get(groupId, req.user.id);
    if (!group) return next(new HttpError(404, 'Групу не знайдено'));
    req.group = group;
    next();
  };

  const groupMembers = (groupId) =>
    db
      .prepare(
        `SELECT u.id, u.name, u.email FROM group_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.group_id = ? ORDER BY m.rowid`,
      )
      .all(groupId);

  const groupExpenses = (groupId) => {
    const expenses = db
      .prepare(
        `SELECT id, description, amount, paid_by AS paidBy, created_by AS createdBy, date, created_at AS createdAt
         FROM expenses WHERE group_id = ? ORDER BY date DESC, id DESC`,
      )
      .all(groupId);
    const shares = db
      .prepare(
        `SELECT s.expense_id AS expenseId, s.user_id AS userId, s.amount
         FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
         WHERE e.group_id = ?`,
      )
      .all(groupId);
    const byExpense = new Map(expenses.map((e) => [e.id, { ...e, shares: [] }]));
    for (const s of shares) byExpense.get(s.expenseId)?.shares.push({ userId: s.userId, amount: s.amount });
    return [...byExpense.values()];
  };

  const groupSettlements = (groupId) =>
    db
      .prepare(
        `SELECT id, from_user AS fromUser, to_user AS toUser, amount, date, created_by AS createdBy, created_at AS createdAt
         FROM settlements WHERE group_id = ? ORDER BY date DESC, id DESC`,
      )
      .all(groupId);

  const groupBalances = (groupId, members = groupMembers(groupId)) =>
    computeBalances(
      members.map((m) => m.id),
      groupExpenses(groupId),
      groupSettlements(groupId),
    );

  const isMember = (groupId, userId) =>
    Boolean(db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId));

  app.get('/api/groups', requireUser, (req, res) => {
    const groups = db
      .prepare(
        `SELECT g.id, g.name, g.currency,
                (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS memberCount
         FROM groups g JOIN group_members m ON m.group_id = g.id
         WHERE m.user_id = ? ORDER BY g.created_at DESC, g.id DESC`,
      )
      .all(req.user.id);
    res.json({
      groups: groups.map((g) => ({ ...g, myBalance: groupBalances(g.id).get(req.user.id) ?? 0 })),
    });
  });

  app.post('/api/groups', requireUser, (req, res) => {
    const name = requireString(req.body?.name, 'назва', { max: 100 });
    const groupId = transaction(db, () => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO groups (name, created_by) VALUES (?, ?)')
        .run(name, req.user.id);
      db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(lastInsertRowid, req.user.id);
      return Number(lastInsertRowid);
    });
    res.status(201).json({ group: { id: groupId, name, currency: 'UAH' } });
  });

  app.get('/api/groups/:groupId', requireUser, loadGroup, (req, res) => {
    const groupId = req.group.id;
    const members = groupMembers(groupId);
    const expenses = groupExpenses(groupId);
    const settlements = groupSettlements(groupId);
    const balances = computeBalances(
      members.map((m) => m.id),
      expenses,
      settlements,
    );
    res.json({
      group: req.group,
      members,
      expenses,
      settlements,
      balances: [...balances].map(([userId, balance]) => ({ userId, balance })),
      suggestedTransfers: simplifyDebts(balances),
    });
  });

  app.post('/api/groups/:groupId/members', requireUser, loadGroup, (req, res) => {
    const email = requireString(req.body?.email, 'email').toLowerCase();
    const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email);
    if (!user) fail(404, 'Користувача з таким email не знайдено. Попросіть його спершу зареєструватися.');
    if (isMember(req.group.id, user.id)) fail(409, 'Користувач уже є учасником групи');
    db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(req.group.id, user.id);
    res.status(201).json({ member: user });
  });

  app.delete('/api/groups/:groupId/members/:userId', requireUser, loadGroup, (req, res) => {
    const userId = requireId(req.params.userId, 'учасник');
    if (!isMember(req.group.id, userId)) fail(404, 'Учасника не знайдено');
    const balance = groupBalances(req.group.id).get(userId) ?? 0;
    if (balance !== 0) fail(409, 'Не можна видалити учасника з ненульовим балансом');
    const involved = db
      .prepare(
        `SELECT 1 FROM expenses e WHERE e.group_id = ? AND e.paid_by = ?
         UNION SELECT 1 FROM expense_shares s JOIN expenses e ON e.id = s.expense_id WHERE e.group_id = ? AND s.user_id = ?
         UNION SELECT 1 FROM settlements WHERE group_id = ? AND (from_user = ? OR to_user = ?)
         LIMIT 1`,
      )
      .get(req.group.id, userId, req.group.id, userId, req.group.id, userId, userId);
    if (involved) fail(409, 'Учасник має історію витрат у групі, його не можна видалити');
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(req.group.id, userId);
    res.json({ ok: true });
  });

  // ---------- Витрати ----------

  function buildShares(groupId, amount, split) {
    if (!split || typeof split !== 'object') fail(400, 'Не вказано, як розділити витрату');

    if (split.type === 'equal') {
      if (!Array.isArray(split.participants) || split.participants.length === 0) {
        fail(400, 'Оберіть хоча б одного учасника');
      }
      const ids = [...new Set(split.participants.map((id) => requireId(id, 'учасник')))];
      for (const id of ids) if (!isMember(groupId, id)) fail(400, 'Учасник не належить до групи');
      return splitEqually(amount, ids);
    }

    if (split.type === 'exact') {
      if (!Array.isArray(split.shares) || split.shares.length === 0) fail(400, 'Вкажіть частки учасників');
      const seen = new Set();
      const shares = split.shares.map((s) => {
        const userId = requireId(s?.userId, 'учасник');
        if (seen.has(userId)) fail(400, 'Учасник вказаний двічі');
        seen.add(userId);
        if (!isMember(groupId, userId)) fail(400, 'Учасник не належить до групи');
        if (!Number.isInteger(s.amount) || s.amount < 0) fail(400, 'Некоректна частка');
        return { userId, amount: s.amount };
      });
      const total = shares.reduce((sum, s) => sum + s.amount, 0);
      if (total !== amount) fail(400, 'Сума часток має дорівнювати сумі витрати');
      return shares.filter((s) => s.amount > 0);
    }

    fail(400, 'Невідомий спосіб розподілу');
  }

  app.post('/api/groups/:groupId/expenses', requireUser, loadGroup, (req, res) => {
    const groupId = req.group.id;
    const description = requireString(req.body?.description, 'опис');
    const amount = requireAmount(req.body?.amount);
    const paidBy = requireId(req.body?.paidBy ?? req.user.id, 'платник');
    if (!isMember(groupId, paidBy)) fail(400, 'Платник не належить до групи');
    const date = normalizeDate(req.body?.date);
    const shares = buildShares(groupId, amount, req.body?.split);

    const expenseId = transaction(db, () => {
      const { lastInsertRowid } = db
        .prepare(
          'INSERT INTO expenses (group_id, description, amount, paid_by, created_by, date) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(groupId, description, amount, paidBy, req.user.id, date);
      const insertShare = db.prepare('INSERT INTO expense_shares (expense_id, user_id, amount) VALUES (?, ?, ?)');
      for (const s of shares) insertShare.run(lastInsertRowid, s.userId, s.amount);
      return Number(lastInsertRowid);
    });
    res.status(201).json({ expense: { id: expenseId, description, amount, paidBy, date, shares } });
  });

  app.delete('/api/groups/:groupId/expenses/:expenseId', requireUser, loadGroup, (req, res) => {
    const expenseId = requireId(req.params.expenseId, 'витрата');
    const { changes } = db.prepare('DELETE FROM expenses WHERE id = ? AND group_id = ?').run(expenseId, req.group.id);
    if (!changes) fail(404, 'Витрату не знайдено');
    res.json({ ok: true });
  });

  // ---------- Розрахунки (погашення боргів) ----------

  app.post('/api/groups/:groupId/settlements', requireUser, loadGroup, (req, res) => {
    const groupId = req.group.id;
    const fromUser = requireId(req.body?.fromUser, 'від кого');
    const toUser = requireId(req.body?.toUser, 'кому');
    if (fromUser === toUser) fail(400, 'Не можна переказати гроші самому собі');
    if (!isMember(groupId, fromUser) || !isMember(groupId, toUser)) fail(400, 'Учасник не належить до групи');
    const amount = requireAmount(req.body?.amount);
    const date = normalizeDate(req.body?.date);
    const { lastInsertRowid } = db
      .prepare(
        'INSERT INTO settlements (group_id, from_user, to_user, amount, date, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(groupId, fromUser, toUser, amount, date, req.user.id);
    res.status(201).json({ settlement: { id: Number(lastInsertRowid), fromUser, toUser, amount, date } });
  });

  app.delete('/api/groups/:groupId/settlements/:settlementId', requireUser, loadGroup, (req, res) => {
    const settlementId = requireId(req.params.settlementId, 'розрахунок');
    const { changes } = db
      .prepare('DELETE FROM settlements WHERE id = ? AND group_id = ?')
      .run(settlementId, req.group.id);
    if (!changes) fail(404, 'Розрахунок не знайдено');
    res.json({ ok: true });
  });

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Не знайдено')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некоректний JSON' });
    console.error(err);
    res.status(500).json({ error: 'Внутрішня помилка сервера' });
  });

  return app;
}
