import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

let server;
let baseUrl;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

test('повний сценарій: група, витрати, баланси, розрахунок', async () => {
  const anna = client();
  const bohdan = client();
  const vira = client();

  const a = await anna('POST', '/api/auth/register', { email: 'anna@example.com', name: 'Анна', password: 'password1' });
  assert.equal(a.status, 201);
  const b = await bohdan('POST', '/api/auth/register', { email: 'bohdan@example.com', name: 'Богдан', password: 'password2' });
  const v = await vira('POST', '/api/auth/register', { email: 'vira@example.com', name: 'Віра', password: 'password3' });
  const [annaId, bohdanId, viraId] = [a.body.user.id, b.body.user.id, v.body.user.id];

  const dup = await client()('POST', '/api/auth/register', { email: 'ANNA@example.com', name: 'X', password: 'password1' });
  assert.equal(dup.status, 409);

  const g = await anna('POST', '/api/groups', { name: 'Поїздка в Карпати' });
  assert.equal(g.status, 201);
  const groupId = g.body.group.id;

  // Богдан ще не учасник — групи не бачить.
  assert.equal((await bohdan('GET', `/api/groups/${groupId}`)).status, 404);

  assert.equal((await anna('POST', `/api/groups/${groupId}/members`, { email: 'bohdan@example.com' })).status, 201);
  assert.equal((await anna('POST', `/api/groups/${groupId}/members`, { email: 'vira@example.com' })).status, 201);
  assert.equal((await anna('POST', `/api/groups/${groupId}/members`, { email: 'nobody@example.com' })).status, 404);

  // Анна платить 900 грн за всіх порівну.
  let r = await anna('POST', `/api/groups/${groupId}/expenses`, {
    description: 'Житло',
    amount: 90000,
    paidBy: annaId,
    split: { type: 'equal', participants: [annaId, bohdanId, viraId] },
  });
  assert.equal(r.status, 201);

  // Богдан платить 300 грн, точні частки: Віра 200, Богдан 100.
  r = await bohdan('POST', `/api/groups/${groupId}/expenses`, {
    description: 'Продукти',
    amount: 30000,
    paidBy: bohdanId,
    split: { type: 'exact', shares: [{ userId: viraId, amount: 20000 }, { userId: bohdanId, amount: 10000 }] },
  });
  assert.equal(r.status, 201);

  // Некоректні частки відхиляються.
  r = await bohdan('POST', `/api/groups/${groupId}/expenses`, {
    description: 'Помилка',
    amount: 100,
    split: { type: 'exact', shares: [{ userId: viraId, amount: 50 }] },
  });
  assert.equal(r.status, 400);

  let detail = (await vira('GET', `/api/groups/${groupId}`)).body;
  const balanceOf = (id) => detail.balances.find((x) => x.userId === id).balance;
  assert.equal(balanceOf(annaId), 60000);
  assert.equal(balanceOf(bohdanId), -10000);
  assert.equal(balanceOf(viraId), -50000);
  assert.equal(detail.balances.reduce((s, x) => s + x.balance, 0), 0);
  assert.deepEqual(detail.suggestedTransfers, [
    { from: viraId, to: annaId, amount: 50000 },
    { from: bohdanId, to: annaId, amount: 10000 },
  ]);

  // Віра повертає борг Анні.
  r = await vira('POST', `/api/groups/${groupId}/settlements`, { fromUser: viraId, toUser: annaId, amount: 50000 });
  assert.equal(r.status, 201);
  detail = (await vira('GET', `/api/groups/${groupId}`)).body;
  assert.equal(balanceOf(viraId), 0);
  assert.deepEqual(detail.suggestedTransfers, [{ from: bohdanId, to: annaId, amount: 10000 }]);

  const list = (await bohdan('GET', '/api/groups')).body.groups;
  assert.equal(list.length, 1);
  assert.equal(list[0].myBalance, -10000);
  assert.equal(list[0].memberCount, 3);
});

test('API вимагає автентифікації та JSON', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/groups')).status, 401);
  assert.equal((await anon('GET', '/api/me')).status, 401);

  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=a&password=b',
  });
  assert.equal(res.status, 415);

  const bad = await anon('POST', '/api/auth/login', { email: 'anna@example.com', password: 'wrong-password' });
  assert.equal(bad.status, 401);
});

test('вихід анулює сесію', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'logout@example.com', name: 'Л', password: 'password1' });
  assert.equal((await c('GET', '/api/me')).status, 200);
  await c('POST', '/api/auth/logout', {});
  assert.equal((await c('GET', '/api/me')).status, 401);
});
