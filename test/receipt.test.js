import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceipt } from '../public/receipt.js';

test('український фіскальний чек: позиції, кількість×ціна та підсумок', () => {
  const text = `
ТОВ "СІЛЬПО-ФУД"
м. Київ, вул. Хрещатик 1
ПН 123456789012
Хліб Київхліб Український
1 x 25.50 = 25.50 А
2.000 x 15.00
Молоко Галичина 2.5%       30.00 А
Банани вагові 1,234 кг   61,70 А
Пакет                     2.00 Б
СУМА                    119.20
ПДВ А 20%                19.87
КАРТКА                  119.20
12.05.2024 14:33:10
`;
  const { items, total } = parseReceipt(text);
  assert.deepEqual(items, [
    { name: 'Хліб Київхліб Український', amount: 2550 },
    { name: 'Молоко Галичина 2.5%', amount: 3000 },
    { name: 'Банани вагові 1,234 кг', amount: 6170 },
    { name: 'Пакет', amount: 200 },
  ]);
  assert.equal(total, 11920);
});

test('польський чек і помилки розпізнавання', () => {
  const { items, total } = parseReceipt(`
Chleb żytni  1 x4,50  4,50A
Ser gouda 1O ,99 C
Rabat -2,00
SUMA PLN 13,49
Karta 13,49`);
  assert.deepEqual(items, [
    { name: 'Chleb żytni', amount: 450 },
    { name: 'Ser gouda', amount: 1099 },
  ]);
  assert.equal(total, 1349);
});

test('без рядка з підсумком — сума позицій; сміття ігнорується', () => {
  const { items, total } = parseReceipt('Кава лате 65.00\n12.50\n~~ 3 ~~\nКруасан 45,00 грн\nТаксі до готелю 250.00');
  assert.deepEqual(items.map((i) => i.name), ['Кава лате', 'Круасан', 'Таксі до готелю']);
  assert.equal(total, 36000);
  assert.deepEqual(parseReceipt(''), { items: [], total: 0 });
});
