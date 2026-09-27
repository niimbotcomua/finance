import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../public/report.js';

const members = [{ id: 'a', name: 'Анна', email: 'a@x' }, { id: 'b', name: 'Богдан', email: 'b@x' }];
const expenses = [
  { date: '2026-08-10', description: 'Кава', amount: 10000, paidBy: 'a', categoryId: 1, shares: [{ userId: 'a', amount: 5000 }, { userId: 'b', amount: 5000 }], photoCount: 1 },
  { date: '2026-09-02', description: 'Таксі', amount: 30000, paidBy: 'b', categoryId: null, currency: 'EUR', originalAmount: 700, rate: 42.86,
    shares: [{ userId: 'a', amount: 15000 }, { userId: 'b', amount: 15000 }], edited: true },
];
const settlements = [{ date: '2026-09-05', fromUser: 'a', toUser: 'b', amount: 5000 }];
const base = {
  group: { name: 'Поїздка', currency: 'UAH' }, members, expenses, settlements,
  categoryOf: (id) => ({ 1: { name: 'Кафе' } })[id] ?? null, todayIso: '2026-09-26', generatedAt: new Date('2026-09-26T12:00:00Z'),
};
const sheet = (report, name) => report.sheets.find((s) => s.name === name);

test('звіт: усі витрати з частками, валютою, перекази й борги', () => {
  const report = buildReport(base);
  assert.deepEqual(report.sheets.map((s) => s.name), ['Підсумок', 'Витрати', 'Повернення боргів', 'По тегах']);

  const rows = sheet(report, 'Витрати').blocks[0].rows;
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].description, rows[0].tag, rows[0].payer, rows[0].amount, rows[0].share_a, rows[0].photos],
    ['Кава', 'Кафе', 'Анна', 100, 50, 1]);
  assert.deepEqual([rows[1].currency, rows[1].original, rows[1].rate, rows[1].edited], ['EUR', 7, 42.86, 'так']);
  assert.equal(sheet(report, 'Витрати').blocks[0].totals.amount, 400);

  const [, people, debts] = sheet(report, 'Підсумок').blocks;
  // Анна: заплатила 100, частка 200, повернула 50 → винна 50.
  assert.deepEqual(people.rows.map((p) => [p.name, p.paid, p.share, p.balance, p.state]),
    [['Анна', 100, 200, -50, 'він винен'], ['Богдан', 300, 200, 50, 'йому винні']]);
  assert.deepEqual(debts.rows, [{ from: 'Анна', to: 'Богдан', amount: 50 }]);
  assert.deepEqual(sheet(report, 'Повернення боргів').blocks[0].rows, [{ date: '2026-09-05', from: 'Анна', to: 'Богдан', amount: 50 }]);
  assert.deepEqual(sheet(report, 'По тегах').blocks[0].rows.map((r) => [r.tag, r.total]), [['Без тегу', 300], ['Кафе', 100]]);
});

test('звіт за період: лише витрати періоду, але баланси — на сьогодні', () => {
  const report = buildReport({ ...base, period: 'month' });
  assert.equal(sheet(report, 'Витрати').blocks[0].rows.length, 1);
  const people = sheet(report, 'Підсумок').blocks[1].rows;
  assert.equal(people[0].paid, 0); // у вересні Анна не платила
  assert.equal(people[0].balance, -50); // але винна за весь час
});

test('PDF: A4, усі витрати з частками й валютою, підсумки', async () => {
  const { buildPdfDoc } = await import('../public/report.js');
  const doc = buildPdfDoc(buildReport(base));
  assert.equal(doc.pageSize, 'A4');
  const tables = doc.content.filter((c) => c.table).map((c) => c.table);
  assert.equal(tables.every((t) => t.headerRows === 1), true); // шапка таблиць повторюється на нових сторінках
  const expensesTable = tables.find((t) => t.body[0].some((cell) => cell.text === 'Витрати учасників'));
  const texts = expensesTable.body.map((row) => row.map((cell) => cell.text));
  assert.equal(texts.length, 1 + 2 + 1); // шапка, 2 витрати, «Разом»
  assert.match(texts[1][2], /Кава\n#Кафе\nфото: 1/);
  assert.equal(texts[1][5], 'Анна 50,00\nБогдан 50,00');
  assert.match(texts[2][4], /300,00\n\(7,00 EUR\)/);
  assert.deepEqual([texts[3][2], texts[3][4]], ['Разом', '400,00']);
  assert.equal(doc.footer(2, 3).columns[1].text, 'Сторінка 2 з 3');
});
