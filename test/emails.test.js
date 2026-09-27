import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildModule } from '../scripts/build-email-templates.js';
import { buildEmails, htmlToText, render } from '../supabase/functions/send-email/emails.js';

const SITE = 'https://finance.example.com/';
const payload = (email_action_type, extra = {}) => ({
  user: { email: 'old@example.com', new_email: 'new@example.com' },
  email_data: { email_action_type, site_url: 'https://db.example.com/auth/v1', token_hash: 'hash1', token_hash_new: '', ...extra },
});

test('Листи: templates.js згенеровано з актуальних шаблонів (npm run build:emails)', () => {
  const current = readFileSync(new URL('../supabase/functions/send-email/templates.js', import.meta.url), 'utf8');
  assert.equal(current, buildModule());
});

test('Листи: реєстрація — посилання на сайт із token_hash, тема й текстова версія', () => {
  const [mail, ...rest] = buildEmails(payload('signup'), SITE);
  assert.equal(rest.length, 0);
  assert.equal(mail.to, 'old@example.com');
  assert.equal(mail.subject, 'Підтвердіть реєстрацію у «Спільні витрати»');
  assert.match(mail.html, /href="https:\/\/finance\.example\.com\/\?token_hash=hash1&amp;type=email"/);
  assert.doesNotMatch(mail.html, /{{/);
  assert.match(mail.text, /https:\/\/finance\.example\.com\/\?token_hash=hash1&type=email/);
  assert.doesNotMatch(mail.text, /<|&amp;/);
});

test('Листи: відновлення пароля й запрошення — свої шаблони та type', () => {
  assert.match(buildEmails(payload('recovery'), SITE)[0].html, /type=recovery/);
  assert.equal(buildEmails(payload('invite'), SITE)[0].subject, 'Вас запрошено до «Спільні витрати»');
  assert.match(buildEmails(payload('magiclink'), SITE)[0].html, /type=email"/);
});

test('Листи: зміна пошти — два листи, token_hash_new іде на ПОТОЧНУ адресу', () => {
  const mails = buildEmails(payload('email_change', { token_hash: 'forNew', token_hash_new: 'forCurrent' }), SITE);
  assert.deepEqual(mails.map((m) => m.to), ['old@example.com', 'new@example.com']);
  assert.match(mails[0].html, /token_hash=forCurrent/);
  assert.match(mails[1].html, /token_hash=forNew/);
  assert.match(mails[0].html, /old@example\.com.*new@example\.com/s);
});

test('Листи: без secure email change — один лист на нову адресу', () => {
  const mails = buildEmails(payload('email_change', { token_hash: 'only' }), SITE);
  assert.deepEqual(mails.map((m) => m.to), ['new@example.com']);
});

test('Листи: невідомі дії пропускаються, значення екрануються', () => {
  assert.deepEqual(buildEmails(payload('reauthentication'), SITE), []);
  assert.equal(render('<b>{{ .Email }}</b> {{ .Other }}', { Email: '<x>' }), '<b>&lt;x&gt;</b> {{ .Other }}');
  assert.equal(htmlToText('<p>Привіт&nbsp;<a href="https://a.b/?x=1&amp;y=2">тут</a></p>'), 'Привіт тут: https://a.b/?x=1&y=2\n');
});

test('Листи: сповіщення про витрату — кожному отримувачу своя частка, дані екрануються', async () => {
  const { buildExpenseEmails } = await import('../supabase/functions/notify-expense/expense-email.js');
  const mails = buildExpenseEmails({
    group_id: 7, group_name: 'Дача <1>', description: 'Дрова', amount: '300,00 грн', original: null,
    date: '2026-09-27', payer: 'Богдан', author: null,
    recipients: [{ email: 'b@example.com', name: 'Богдан', share: '150,00 грн' }, { email: 'v@example.com', name: 'Віра', share: null }],
  }, SITE);
  assert.deepEqual(mails.map((m) => m.to), ['b@example.com', 'v@example.com']);
  assert.equal(mails[0].subject, 'Дрова — 300,00 грн · «Дача <1>»');
  assert.match(mails[0].html, /«Дача &lt;1&gt;»/);
  assert.match(mails[0].html, /href="https:\/\/finance\.example\.com\/#\/groups\/7"/);
  assert.match(mails[0].text, /Ваша частка\s*150,00 грн/);
  assert.match(mails[0].text, /Дата\s*27\.09\.2026/);
  assert.doesNotMatch(mails[0].text, /Додав\(ла\)/);
  assert.match(mails[1].text, /вас немає серед тих/);
});

test('Листи: звіт по групі — тема, відправник і посилання на групу', async () => {
  const { buildReportEmail } = await import('../supabase/functions/send-report/report-email.js');
  const mail = buildReportEmail({ groupName: 'Відпустка', groupId: 3, periodLabel: 'Цей місяць', senderName: 'Анна', siteUrl: SITE });
  assert.equal(mail.subject, 'Звіт по групі «Відпустка»');
  assert.match(mail.text, /Анна надсилає звіт по групі «Відпустка» \(період: Цей місяць\)\./);
  assert.match(mail.html, /#\/groups\/3/);
});
