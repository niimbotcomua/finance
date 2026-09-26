import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterByPeriod, periodRange, summarize } from '../public/analytics.js';

const expenses = [
  { amount: 5000, paidBy: 'a', date: '2026-09-26', categoryId: 2, shares: [{ userId: 'a', amount: 2000 }, { userId: 'b', amount: 3000 }] },
  { amount: 14500, paidBy: 'b', date: '2026-09-20', categoryId: null, shares: [{ userId: 'a', amount: 7250 }, { userId: 'b', amount: 7250 }] },
  { amount: 1000, paidBy: 'a', date: '2026-08-31', categoryId: 2, shares: [{ userId: 'a', amount: 1000 }] },
];

test('summarize: загальна сума, середній чек, учасники, теги, місяці', () => {
  const s = summarize(expenses, ['a', 'b', 'c']);
  assert.equal(s.total, 20500);
  assert.equal(s.count, 3);
  assert.equal(s.average, 6833);
  assert.equal(s.perMember, 6833);
  const a = s.people.find((p) => p.userId === 'a');
  assert.deepEqual(a, { userId: 'a', paid: 6000, share: 10250, shareCount: 3, averageShare: 3417 });
  assert.equal(s.people.find((p) => p.userId === 'c').share, 0);
  assert.deepEqual(s.categories, [{ categoryId: null, total: 14500, count: 1 }, { categoryId: 2, total: 6000, count: 2 }]);
  assert.deepEqual(s.months, [{ month: '2026-08', total: 1000 }, { month: '2026-09', total: 19500 }]);
});

test('summarize: порожньо — нулі без ділення на нуль', () => {
  const s = summarize([], []);
  assert.equal(s.average, 0);
  assert.equal(s.perMember, 0);
});

test('periodRange і filterByPeriod', () => {
  assert.deepEqual(periodRange('month', '2026-12-05'), { from: '2026-12-01', to: '2027-01-01' });
  assert.deepEqual(periodRange('prev-month', '2026-01-05'), { from: '2025-12-01', to: '2026-01-01' });
  assert.deepEqual(periodRange('year', '2026-09-26'), { from: '2026-01-01', to: '2027-01-01' });
  assert.equal(filterByPeriod(expenses, 'month', '2026-09-26').length, 2);
  assert.equal(filterByPeriod(expenses, 'prev-month', '2026-09-26').length, 1);
  assert.equal(filterByPeriod(expenses, 'all', '2026-09-26').length, 3);
});
