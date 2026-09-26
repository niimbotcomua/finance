import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterExpenses, filterGroups, filterRange, isFiltered } from '../public/filters.js';

const today = '2026-09-26';

test('групи: пошук за назвою, період створення й баланс', () => {
  const groups = [
    { name: 'Поїздка Альпи', createdAt: '2026-09-02T10:00:00Z', myBalance: -500 },
    { name: 'Квартира Київ', createdAt: '2026-08-15T10:00:00Z', myBalance: 1200 },
    { name: 'Карпати', createdAt: '2025-12-31T23:00:00Z', myBalance: 0 },
  ];
  const names = (f) => filterGroups(groups, { query: '', period: 'all', balance: 'all', ...f }, today).map((g) => g.name);
  assert.deepEqual(names({ query: 'альпи' }), ['Поїздка Альпи']);
  assert.deepEqual(names({ query: '  КВАРТИРА   київ ' }), ['Квартира Київ']);
  assert.deepEqual(names({ period: 'month' }), ['Поїздка Альпи']);
  assert.deepEqual(names({ period: 'prev-month' }), ['Квартира Київ']);
  assert.deepEqual(names({ period: 'year' }), ['Поїздка Альпи', 'Квартира Київ']);
  assert.deepEqual(names({ period: 'custom', from: '2025-12-01', to: '2026-08-15' }), ['Квартира Київ', 'Карпати']);
  assert.deepEqual(names({ balance: 'owed' }), ['Квартира Київ']);
  assert.deepEqual(names({ balance: 'owe' }), ['Поїздка Альпи']);
  assert.deepEqual(names({ balance: 'settled' }), ['Карпати']);
});

test('витрати: пошук за описом, тегом, платником і сумою; фільтри', () => {
  const expenses = [
    { description: 'Супермаркет', date: '2026-09-20', amount: 100000, paidBy: 'a', categoryId: 1, shares: [{ userId: 'a', amount: 50000 }, { userId: 'b', amount: 50000 }] },
    { description: 'Таксі', date: '2026-08-10', amount: 25050, originalAmount: 600, paidBy: 'b', categoryId: null, shares: [{ userId: 'b', amount: 25050 }] },
    { description: 'Вечеря', date: '2026-09-01', amount: 200000, paidBy: 'b', categoryId: 2, shares: [{ userId: 'c', amount: 200000 }] },
  ];
  const ctx = { meId: 'a', nameOf: (id) => ({ a: 'Денис', b: 'Alex', c: 'Томера' })[id], categoryName: (id) => ({ 1: 'Покупки', 2: 'Кафе й ресторани' })[id] };
  const names = (f) => filterExpenses(expenses, { query: '', period: 'all', ...f }, ctx, today).map((e) => e.description);
  assert.deepEqual(names({ query: 'супер' }), ['Супермаркет']);
  assert.deepEqual(names({ query: 'кафе' }), ['Вечеря']); // за тегом
  assert.deepEqual(names({ query: 'alex' }), ['Таксі', 'Вечеря']); // за платником
  assert.deepEqual(names({ query: '2000' }), ['Вечеря']); // за сумою
  assert.deepEqual(names({ query: '250,50' }), ['Таксі']);
  assert.deepEqual(names({ query: '6' }), ['Таксі']); // сума у валюті (6,00)
  assert.deepEqual(names({ period: 'month' }), ['Супермаркет', 'Вечеря']);
  assert.deepEqual(names({ categoryId: '1' }), ['Супермаркет']);
  assert.deepEqual(names({ categoryId: 'none' }), ['Таксі']);
  assert.deepEqual(names({ payerId: 'b' }), ['Таксі', 'Вечеря']);
  assert.deepEqual(names({ onlyMine: true }), ['Супермаркет']);
  assert.deepEqual(names({ period: 'custom', from: '2026-09-01', to: '2026-09-01' }), ['Вечеря']); // кінцева дата включно
});

test('допоміжне: межі періоду й ознака активних фільтрів', () => {
  assert.deepEqual(filterRange({ period: 'custom', from: '', to: '2026-02-28' }, today), { from: null, to: '2026-03-01' });
  assert.equal(isFiltered({ query: ' ', period: 'all' }), false);
  assert.equal(isFiltered({ query: '', period: 'all', onlyMine: true }), true);
});
