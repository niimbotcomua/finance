// Звіт по групі для Excel / Google Таблиць.
// buildReport — чисті дані (аркуші, таблиці, рядки), writeWorkbook — запис у .xlsx через ExcelJS.
// Суми на вході — у копійках; у звіті — у гривнях (числа, щоб у таблиці можна було рахувати).

import { computeBalances, simplifyDebts } from './balances.js';
import { filterByPeriod, periodRange, summarize } from './analytics.js';

export const REPORT_PERIODS = {
  all: 'Увесь час',
  month: 'Цей місяць',
  'prev-month': 'Минулий місяць',
  year: 'Цей рік',
};

const money = (kopecks) => Math.round(kopecks) / 100;
const col = (header, key, type = 'text', width = 14) => ({ header, key, type, width });

/**
 * data: { group: { name, currency }, members: [{ id, name, email }], expenses, settlements, categoryOf(id),
 *         period, todayIso, generatedAt: Date, currencyName }
 * expenses: [{ date, description, amount, paidBy, categoryId, currency, originalAmount, rate, shares, photoCount, edited }]
 * settlements: [{ date, fromUser, toUser, amount }]
 */
export function buildReport(data) {
  const { group, members, categoryOf, period = 'all', todayIso } = data;
  const nameOf = (id) => members.find((m) => m.id === id)?.name ?? '—';
  const memberIds = members.map((m) => m.id);
  const { from, to } = periodRange(period, todayIso);
  const inPeriod = (date) => (!from || date >= from) && (!to || date < to);

  const expenses = filterByPeriod(data.expenses, period, todayIso)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const settlements = data.settlements.filter((s) => inPeriod(s.date)).slice().sort((a, b) => a.date.localeCompare(b.date));
  const summary = summarize(expenses, memberIds);

  // Баланси й борги — завжди на сьогодні (за весь час), бо саме їх треба повертати.
  const balanceMap = computeBalances(memberIds, data.expenses, data.settlements);
  const debts = simplifyDebts(balanceMap);

  const periodLabel = REPORT_PERIODS[period] ?? REPORT_PERIODS.all;
  const summarySheet = {
    name: 'Підсумок',
    blocks: [
      {
        title: `Звіт по групі «${group.name}»`,
        columns: [col('Показник', 'label', 'text', 30), col('Значення', 'value', 'text', 26)],
        rows: [
          { label: 'Група', value: group.name },
          { label: 'Основна валюта', value: data.currencyName ? `${group.currency} — ${data.currencyName}` : group.currency },
          { label: 'Період', value: from ? `${periodLabel} (${from} — ${to})` : periodLabel },
          { label: 'Сформовано', value: data.generatedAt },
          { label: 'Учасників', value: members.length },
          { label: 'Витрат', value: summary.count },
          { label: `Загальна сума, ${group.currency}`, value: money(summary.total), type: 'money' },
          { label: `Середній чек, ${group.currency}`, value: money(summary.average), type: 'money' },
          { label: `Повернень боргу, ${group.currency}`, value: money(settlements.reduce((s, x) => s + x.amount, 0)), type: 'money' },
        ],
      },
      {
        title: 'Учасники',
        columns: [
          col('Учасник', 'name', 'text', 22), col('Email', 'email', 'text', 28),
          col(`Заплатив за період, ${group.currency}`, 'paid', 'money', 18),
          col(`Його частка за період, ${group.currency}`, 'share', 'money', 18),
          col(`Баланс на сьогодні, ${group.currency}`, 'balance', 'money', 18),
          col('Стан', 'state', 'text', 16),
        ],
        rows: members.map((m) => {
          const p = summary.people.find((x) => x.userId === m.id) ?? { paid: 0, share: 0 };
          const balance = balanceMap.get(m.id) ?? 0;
          return {
            name: m.name, email: m.email ?? '', paid: money(p.paid), share: money(p.share), balance: money(balance),
            state: balance > 0 ? 'йому винні' : balance < 0 ? 'він винен' : 'розраховано',
          };
        }),
      },
      {
        title: 'Хто кому винен зараз',
        columns: [col('Хто', 'from', 'text', 22), col('Кому', 'to', 'text', 22), col(`Сума, ${group.currency}`, 'amount', 'money', 16)],
        rows: debts.length > 0
          ? debts.map((t) => ({ from: nameOf(t.from), to: nameOf(t.to), amount: money(t.amount) }))
          : [{ from: 'Усі розрахувалися', to: '', amount: null }],
      },
    ],
  };

  const expensesSheet = {
    name: 'Витрати',
    filter: true,
    blocks: [{
      columns: [
        col('№', 'n', 'number', 5), col('Дата', 'date', 'date', 12), col('Опис', 'description', 'text', 30),
        col('Тег', 'tag', 'text', 18), col('Хто платив', 'payer', 'text', 18),
        col(`Сума, ${group.currency}`, 'amount', 'money', 14),
        col('Валюта витрати', 'currency', 'text', 10), col('Сума у валюті', 'original', 'money', 14), col('Курс', 'rate', 'rate', 10),
        ...members.map((m) => col(`Частка: ${m.name}`, `share_${m.id}`, 'money', 14)),
        col('Фото', 'photos', 'number', 7), col('Змінено', 'edited', 'text', 9),
      ],
      rows: expenses.map((e, i) => {
        const category = e.categoryId ? categoryOf(e.categoryId) : null;
        const shares = Object.fromEntries(members.map((m) => {
          const s = e.shares.find((x) => x.userId === m.id);
          return [`share_${m.id}`, s ? money(s.amount) : null];
        }));
        return {
          n: i + 1, date: e.date, description: e.description, tag: category?.name ?? '',
          payer: nameOf(e.paidBy), amount: money(e.amount),
          currency: e.currency ?? group.currency,
          original: e.currency ? money(e.originalAmount) : money(e.amount),
          rate: e.currency ? e.rate : 1,
          ...shares,
          photos: e.photoCount ?? 0, edited: e.edited ? 'так' : '',
        };
      }),
      totals: { description: 'Разом', amount: money(summary.total) },
    }],
  };

  const settlementsSheet = {
    name: 'Повернення боргів',
    blocks: [{
      columns: [col('Дата', 'date', 'date', 12), col('Хто віддав', 'from', 'text', 22), col('Кому', 'to', 'text', 22), col(`Сума, ${group.currency}`, 'amount', 'money', 16)],
      rows: settlements.map((s) => ({ date: s.date, from: nameOf(s.fromUser), to: nameOf(s.toUser), amount: money(s.amount) })),
    }],
  };

  const tagsSheet = {
    name: 'По тегах',
    blocks: [{
      columns: [col('Тег', 'tag', 'text', 24), col('Витрат', 'count', 'number', 10), col(`Сума, ${group.currency}`, 'total', 'money', 16), col('Частка', 'pct', 'percent', 10)],
      rows: summary.categories.map((c) => ({
        tag: c.categoryId ? categoryOf(c.categoryId)?.name ?? '—' : 'Без тегу',
        count: c.count, total: money(c.total), pct: summary.total ? c.total / summary.total : 0,
      })),
    }],
  };

  return { sheets: [summarySheet, expensesSheet, settlementsSheet, tagsSheet] };
}

const FORMATS = { money: '#,##0.00', rate: '0.0000', percent: '0.0%', date: 'dd.mm.yyyy', datetime: 'dd.mm.yyyy hh:mm' };

/** Записує звіт у книгу ExcelJS і повертає її (далі — workbook.xlsx.writeBuffer()). */
export function writeWorkbook(ExcelJS, report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Спільні витрати';
  wb.created = new Date();
  const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFF3' } };

  for (const sheet of report.sheets) {
    const ws = wb.addWorksheet(sheet.name);
    let rowIndex = 1;
    const widths = [];
    for (const block of sheet.blocks) {
      block.columns.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, c.width); });
      if (block.title) {
        const cell = ws.getCell(rowIndex, 1);
        cell.value = block.title;
        cell.font = { bold: true, size: 13 };
        rowIndex += 1;
      }
      const headerRow = ws.getRow(rowIndex);
      block.columns.forEach((c, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = c.header;
        cell.font = { bold: true };
        cell.fill = headerFill;
        cell.alignment = { vertical: 'middle', wrapText: true };
      });
      const headerIndex = rowIndex;
      rowIndex += 1;
      const firstDataRow = rowIndex;
      const writeRow = (row, bold = false) => {
        const excelRow = ws.getRow(rowIndex);
        block.columns.forEach((c, i) => {
          let value = row[c.key];
          const type = row.type && c.key === 'value' ? row.type : c.type;
          if (value === undefined || value === null || value === '') return;
          const cell = excelRow.getCell(i + 1);
          if (type === 'date' && typeof value === 'string') value = new Date(`${value}T00:00:00Z`);
          cell.value = value;
          if (value instanceof Date) cell.numFmt = type === 'date' ? FORMATS.date : FORMATS.datetime;
          else if (FORMATS[type]) cell.numFmt = FORMATS[type];
          if (bold) cell.font = { bold: true };
        });
        rowIndex += 1;
      };
      block.rows.forEach((row) => writeRow(row));
      if (block.totals && block.rows.length > 0) writeRow(block.totals, true);
      if (sheet.filter && block.rows.length > 0) {
        ws.autoFilter = { from: { row: headerIndex, column: 1 }, to: { row: firstDataRow + block.rows.length - 1, column: block.columns.length } };
      }
      if (sheet.blocks.length === 1) ws.views = [{ state: 'frozen', ySplit: headerIndex }];
      rowIndex += 1; // порожній рядок між таблицями
    }
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  }
  return wb;
}
