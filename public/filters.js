// Пошук і фільтри для списку груп і витрат групи (чисті функції, без DOM).

import { periodRange } from './analytics.js';

export const FILTER_PERIODS = {
  all: 'Увесь час',
  month: 'Цей місяць',
  'prev-month': 'Минулий місяць',
  year: 'Цей рік',
  custom: 'Свої дати',
};

/** Межі періоду [from, to) у YYYY-MM-DD; для «Свої дати» — включно з кінцевою датою. */
export function filterRange({ period = 'all', from = '', to = '' }, todayIso) {
  if (period !== 'custom') return periodRange(period, todayIso);
  const next = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  return { from: from || null, to: to ? next(to) : null };
}

const inRange = (date, { from, to }) => (!from || date >= from) && (!to || date < to);

/** Нормалізує текст для пошуку: нижній регістр, без зайвих пробілів, «ё/ґ» як є. */
export const normalize = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Чи збігається кожне слово запиту з якимось із полів. */
function matches(query, fields) {
  const words = normalize(query).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields.map(normalize).join(' | ');
  return words.every((w) => haystack.includes(w));
}

/** Суми у форматах, як їх може шукати людина: «2000», «2 000», «2000,50». */
function amountVariants(kopecks) {
  if (kopecks === null || kopecks === undefined) return [];
  const units = Math.floor(kopecks / 100);
  const cents = String(kopecks % 100).padStart(2, '0');
  return [`${units}`, `${units},${cents}`, `${units}.${cents}`, units.toLocaleString('uk-UA').replace(/\s/g, ' ')];
}

export const GROUP_BALANCE_FILTERS = {
  all: 'Усі',
  owed: 'Мені винні',
  owe: 'Я винен',
  settled: 'Розраховано',
};

/** groups: [{ name, createdAt (ISO), myBalance }] */
export function filterGroups(groups, filter, todayIso) {
  const range = filterRange(filter, todayIso);
  return groups.filter((g) => {
    if (!matches(filter.query, [g.name])) return false;
    if (!inRange(String(g.createdAt).slice(0, 10), range)) return false;
    switch (filter.balance ?? 'all') {
      case 'owed': return g.myBalance > 0;
      case 'owe': return g.myBalance < 0;
      case 'settled': return g.myBalance === 0;
      default: return true;
    }
  });
}

/**
 * expenses: [{ description, date, amount, originalAmount, paidBy, categoryId, shares: [{ userId, amount }] }]
 * ctx: { meId, nameOf(id), categoryName(id) }
 * filter: { query, period, from, to, categoryId ('' | 'none' | id), payerId, onlyMine }
 */
export function filterExpenses(expenses, filter, ctx, todayIso) {
  const range = filterRange(filter, todayIso);
  return expenses.filter((e) => {
    if (!inRange(e.date, range)) return false;
    if (filter.categoryId === 'none' && e.categoryId) return false;
    if (filter.categoryId && filter.categoryId !== 'none' && String(e.categoryId) !== String(filter.categoryId)) return false;
    if (filter.payerId && e.paidBy !== filter.payerId) return false;
    if (filter.onlyMine && !e.shares.some((s) => s.userId === ctx.meId && s.amount > 0) && e.paidBy !== ctx.meId) return false;
    return matches(filter.query, [
      e.description,
      e.note ?? '',
      e.categoryId ? ctx.categoryName(e.categoryId) : '',
      ctx.nameOf(e.paidBy),
      ...amountVariants(e.amount),
      ...amountVariants(e.originalAmount),
    ]);
  });
}

/** Чи змінено хоч щось відносно «показати все». */
export const isFiltered = (filter) => Boolean(normalize(filter.query) || (filter.period && filter.period !== 'all')
  || (filter.balance && filter.balance !== 'all') || filter.categoryId || filter.payerId || filter.onlyMine);
