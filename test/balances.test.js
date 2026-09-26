import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBalances, remainderShare, simplifyDebts, splitEqually } from '../public/balances.js';

test('splitEqually розподіляє залишок копійок між першими учасниками', () => {
  assert.deepEqual(splitEqually(1000, [1, 2, 3]), [
    { userId: 1, amount: 334 },
    { userId: 2, amount: 333 },
    { userId: 3, amount: 333 },
  ]);
  assert.equal(
    splitEqually(1001, [1, 2, 3, 4]).reduce((s, x) => s + x.amount, 0),
    1001,
  );
});

test('remainderShare віддає залишок останньому незаповненому учаснику', () => {
  const auto = { value: null, manual: false };
  // Двоє: ввели 20 → другому 30.
  assert.deepEqual(remainderShare(5000, [{ value: 2000, manual: true }, auto]), { index: 1, value: 3000 });
  // Троє: ввели першого → залишок останньому; ввели й останнього → залишок середньому.
  assert.deepEqual(remainderShare(5000, [{ value: 2000, manual: true }, auto, auto]), { index: 2, value: 3000 });
  assert.deepEqual(remainderShare(5000, [{ value: 2000, manual: true }, auto, { value: 1000, manual: true }]), { index: 1, value: 2000 });
  // Перебір або вже все розподілено — поле порожнє; усі введено вручну — нічого не робимо.
  assert.deepEqual(remainderShare(5000, [{ value: 6000, manual: true }, auto]), { index: 1, value: null });
  assert.deepEqual(remainderShare(5000, [{ value: 5000, manual: true }, auto]), { index: 1, value: null });
  assert.deepEqual(remainderShare(null, [auto, auto]), { index: 1, value: null });
  assert.equal(remainderShare(5000, [{ value: 5000, manual: true }]), null);
});

test('computeBalances враховує витрати та розрахунки', () => {
  const expenses = [
    { paidBy: 1, amount: 900, shares: [{ userId: 1, amount: 300 }, { userId: 2, amount: 300 }, { userId: 3, amount: 300 }] },
  ];
  const balances = computeBalances([1, 2, 3], expenses, [{ fromUser: 2, toUser: 1, amount: 300 }]);
  assert.deepEqual([...balances], [[1, 300], [2, 0], [3, -300]]);
});

test('simplifyDebts мінімізує перекази та зводить баланси до нуля', () => {
  const balances = new Map([[1, 500], [2, -200], [3, -300], [4, 0]]);
  const transfers = simplifyDebts(balances);
  assert.deepEqual(transfers, [
    { from: 3, to: 1, amount: 300 },
    { from: 2, to: 1, amount: 200 },
  ]);

  const net = new Map(balances);
  for (const t of transfers) {
    net.set(t.from, net.get(t.from) + t.amount);
    net.set(t.to, net.get(t.to) - t.amount);
  }
  assert.ok([...net.values()].every((v) => v === 0));
});
