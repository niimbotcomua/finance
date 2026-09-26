// Аналітика витрат групи. Усі суми — цілі числа в копійках.

/** Межі періоду [from, to) у форматі YYYY-MM-DD; null — без обмеження. */
export function periodRange(period, todayIso) {
  const [y, m] = todayIso.split('-').map(Number);
  const iso = (year, month) => `${year}-${String(month).padStart(2, '0')}-01`;
  const next = (year, month) => (month === 12 ? iso(year + 1, 1) : iso(year, month + 1));
  switch (period) {
    case 'month': return { from: iso(y, m), to: next(y, m) };
    case 'prev-month': return m === 1 ? { from: iso(y - 1, 12), to: iso(y, 1) } : { from: iso(y, m - 1), to: iso(y, m) };
    case 'year': return { from: iso(y, 1), to: iso(y + 1, 1) };
    default: return { from: null, to: null };
  }
}

export function filterByPeriod(expenses, period, todayIso) {
  const { from, to } = periodRange(period, todayIso);
  return expenses.filter((e) => (!from || e.date >= from) && (!to || e.date < to));
}

/**
 * expenses: [{ amount, paidBy, date, categoryId, shares: [{ userId, amount }] }]
 * Повертає підсумки: загалом, по учасниках, по тегах і по місяцях.
 */
export function summarize(expenses, memberIds) {
  const total = expenses.reduce((sum, e) => sum + e.amount, 0);
  const count = expenses.length;

  const people = new Map(memberIds.map((id) => [id, { userId: id, paid: 0, share: 0, shareCount: 0 }]));
  const person = (id) => {
    if (!people.has(id)) people.set(id, { userId: id, paid: 0, share: 0, shareCount: 0 });
    return people.get(id);
  };
  const categories = new Map();
  const months = new Map();

  for (const e of expenses) {
    person(e.paidBy).paid += e.amount;
    for (const s of e.shares) {
      if (s.amount <= 0) continue;
      const p = person(s.userId);
      p.share += s.amount;
      p.shareCount += 1;
    }
    const key = e.categoryId ?? null;
    const c = categories.get(key) ?? { categoryId: key, total: 0, count: 0 };
    c.total += e.amount;
    c.count += 1;
    categories.set(key, c);
    const month = e.date.slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + e.amount);
  }

  return {
    total,
    count,
    average: count ? Math.round(total / count) : 0,
    perMember: memberIds.length ? Math.round(total / memberIds.length) : 0,
    people: [...people.values()]
      .map((p) => ({ ...p, averageShare: p.shareCount ? Math.round(p.share / p.shareCount) : 0 }))
      .sort((a, b) => b.share - a.share),
    categories: [...categories.values()].sort((a, b) => b.total - a.total),
    months: [...months].map(([month, sum]) => ({ month, total: sum })).sort((a, b) => a.month.localeCompare(b.month)),
  };
}
