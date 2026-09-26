// Чиста бізнес-логіка розрахунків. Усі суми — цілі числа в копійках.

/** Ділить суму порівну між учасниками; залишок копійок отримують перші учасники. */
export function splitEqually(amount, userIds) {
  if (userIds.length === 0) throw new Error('Потрібен хоча б один учасник');
  const base = Math.floor(amount / userIds.length);
  let remainder = amount - base * userIds.length;
  return userIds.map((userId) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { userId, amount: base + extra };
  });
}

/**
 * Автопідрахунок залишку для розподілу «точними сумами».
 * entries: [{ value: копійки | null, manual: true — ввів сам користувач }].
 * Залишок (сума мінус введені вручну частки) отримує останнє поле, яке користувач не чіпав.
 * Повертає { index, value } (value = null, якщо залишку немає або він від'ємний) або null, якщо всі поля введено вручну.
 */
export function remainderShare(amount, entries) {
  const index = entries.findLastIndex((e) => !e.manual);
  if (index === -1) return null;
  if (amount === null) return { index, value: null };
  const rest = amount - entries.reduce((sum, e) => sum + (e.manual ? e.value ?? 0 : 0), 0);
  return { index, value: rest > 0 ? rest : null };
}

/**
 * Рахує чистий баланс кожного учасника.
 * Додатний баланс — учаснику винні гроші, від'ємний — учасник винен.
 */
export function computeBalances(memberIds, expenses, settlements) {
  const balances = new Map(memberIds.map((id) => [id, 0]));
  const add = (id, delta) => balances.set(id, (balances.get(id) ?? 0) + delta);

  for (const expense of expenses) {
    add(expense.paidBy, expense.amount);
    for (const share of expense.shares) add(share.userId, -share.amount);
  }
  for (const s of settlements) {
    add(s.fromUser, s.amount);
    add(s.toUser, -s.amount);
  }
  return balances;
}

/**
 * Спрощує борги: мінімізує кількість переказів, жадібно зводячи
 * найбільшого боржника з найбільшим кредитором.
 */
export function simplifyDebts(balances) {
  const creditors = [];
  const debtors = [];
  for (const [userId, balance] of balances) {
    if (balance > 0) creditors.push({ userId, amount: balance });
    else if (balance < 0) debtors.push({ userId, amount: -balance });
  }
  const byAmountDesc = (a, b) => b.amount - a.amount || String(a.userId).localeCompare(String(b.userId));
  creditors.sort(byAmountDesc);
  debtors.sort(byAmountDesc);

  const transfers = [];
  let c = 0;
  let d = 0;
  while (c < creditors.length && d < debtors.length) {
    const amount = Math.min(creditors[c].amount, debtors[d].amount);
    transfers.push({ from: debtors[d].userId, to: creditors[c].userId, amount });
    creditors[c].amount -= amount;
    debtors[d].amount -= amount;
    if (creditors[c].amount === 0) c++;
    if (debtors[d].amount === 0) d++;
  }
  return transfers;
}


/** Сума в іншій валюті → основна валюта за курсом (обидві — у сотих частках). */
export const convertAmount = (original, rate) => Math.round(original * rate);

/**
 * Перераховує частки [{ userId, amount }] за курсом так, щоб їх сума точно дорівнювала total.
 * Копійки від округлення отримують ті, в кого найбільша відкинута дробова частина.
 */
export function convertShares(shares, rate, total) {
  const exact = shares.map((s) => s.amount * rate);
  const result = shares.map((s, i) => ({ userId: s.userId, amount: Math.floor(exact[i]) }));
  let rest = total - result.reduce((sum, s) => sum + s.amount, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  for (let k = 0; rest !== 0 && order.length > 0; k = (k + 1) % order.length) {
    const i = order[k];
    if (rest < 0 && result[i].amount === 0) continue;
    result[i].amount += Math.sign(rest);
    rest -= Math.sign(rest);
  }
  return result;
}
