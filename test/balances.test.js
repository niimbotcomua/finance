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

test('перерахунок валюти: частки в сумі дають перераховану суму', async () => {
  const { convertAmount, convertShares } = await import('../public/balances.js');
  assert.equal(convertAmount(1000, 4.25), 4250);
  assert.equal(convertAmount(333, 41.1234), 13694);
  const shares = [{ userId: 'a', amount: 333 }, { userId: 'b', amount: 333 }, { userId: 'c', amount: 334 }];
  const total = convertAmount(1000, 41.1234);
  const converted = convertShares(shares, 41.1234, total);
  assert.equal(converted.reduce((s, x) => s + x.amount, 0), total);
  assert.ok(converted.every((x, i) => Math.abs(x.amount - shares[i].amount * 41.1234) < 1));
  // Назад (основна → валюта витрати) — теж точно в суму.
  const back = convertShares(converted, 1 / 41.1234, 1000);
  assert.deepEqual(back.map((x) => x.amount), [333, 333, 334]);
});

// Випадкові сценарії (з фіксованим зерном, щоб тест був відтворюваним): гроші не «губляться» ні на копійку.
test('перевірка на тисячах випадкових сценаріїв: поділ, валюта, баланси, спрощення боргів', async () => {
  const { convertAmount, convertShares } = await import('../public/balances.js');
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const total = (list) => list.reduce((s, x) => s + x.amount, 0);
  const rates = [41.25, 44.8712, 0.0123, 1.1, 9.87654321, 0.3333, 3, 26.95];
  for (let t = 0; t < 20000; t++) {
    const ids = Array.from({ length: ri(1, 10) }, (_, i) => `u${i}`);
    const amount = ri(1, 1e9);
    const equal = splitEqually(amount, ids);
    assert.equal(total(equal), amount);
    assert.ok(Math.max(...equal.map((s) => s.amount)) - Math.min(...equal.map((s) => s.amount)) <= 1);

    // Витрата в іншій валюті «точними сумами»: частки в основній валюті дають рівно перераховану суму,
    // кожна — не далі копійки від точного значення, а повторне збереження без змін нічого не зсуває.
    const rate = rates[ri(0, rates.length - 1)];
    const original = ri(100, 1e7);
    const base = convertAmount(original, rate);
    let left = original;
    const shares = ids.map((userId, i) => {
      const v = i === ids.length - 1 ? left : ri(0, left);
      left -= v;
      return { userId, amount: v };
    });
    const converted = convertShares(shares, rate, base);
    assert.equal(total(converted), base);
    converted.forEach((s, i) => assert.ok(Math.abs(s.amount - shares[i].amount * rate) <= 1.000001 && s.amount >= 0));
    const back = convertShares(converted, 1 / rate, original);
    assert.equal(total(back), original);
    assert.deepEqual(convertShares(back, rate, base), converted);

    // Баланси завжди в сумі нуль; запропоновані перекази повністю розраховують групу.
    const expenses = Array.from({ length: ri(1, 6) }, () => {
      const a = ri(1, 1e6);
      return { paidBy: ids[ri(0, ids.length - 1)], amount: a, shares: splitEqually(a, ids.slice(0, ri(1, ids.length))) };
    });
    const balances = computeBalances(ids, expenses, []);
    assert.equal([...balances.values()].reduce((a, b) => a + b, 0), 0);
    const transfers = simplifyDebts(balances);
    assert.ok(transfers.length <= Math.max(ids.length - 1, 0));
    const settled = computeBalances(ids, expenses, transfers.map((x) => ({ fromUser: x.from, toUser: x.to, amount: x.amount })));
    assert.ok([...settled.values()].every((v) => v === 0));
  }
});
