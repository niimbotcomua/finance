import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildModule } from '../scripts/build-email-templates.js';
import { buildEmails, htmlToText, render } from '../supabase/functions/send-email/emails.js';

const payload = (email_action_type, extra = {}) => ({
  user: { email: 'old@example.com', new_email: 'new@example.com' },
  email_data: { email_action_type, site_url: 'https://finance.example.com/', token_hash: 'hash1', token_hash_new: '', ...extra },
});

test('Листи: templates.js згенеровано з актуальних шаблонів (npm run build:emails)', () => {
  const current = readFileSync(new URL('../supabase/functions/send-email/templates.js', import.meta.url), 'utf8');
  assert.equal(current, buildModule());
});

test('Листи: реєстрація — посилання на сайт із token_hash, тема й текстова версія', () => {
  const [mail, ...rest] = buildEmails(payload('signup'));
  assert.equal(rest.length, 0);
  assert.equal(mail.to, 'old@example.com');
  assert.equal(mail.subject, 'Підтвердіть реєстрацію у «Спільні витрати»');
  assert.match(mail.html, /href="https:\/\/finance\.example\.com\/\?token_hash=hash1&amp;type=email"/);
  assert.doesNotMatch(mail.html, /{{/);
  assert.match(mail.text, /https:\/\/finance\.example\.com\/\?token_hash=hash1&type=email/);
  assert.doesNotMatch(mail.text, /<|&amp;/);
});

test('Листи: відновлення пароля й запрошення — свої шаблони та type', () => {
  assert.match(buildEmails(payload('recovery'))[0].html, /type=recovery/);
  assert.equal(buildEmails(payload('invite'))[0].subject, 'Вас запрошено до «Спільні витрати»');
  assert.match(buildEmails(payload('magiclink'))[0].html, /type=email"/);
});

test('Листи: зміна пошти — два листи, token_hash_new іде на ПОТОЧНУ адресу', () => {
  const mails = buildEmails(payload('email_change', { token_hash: 'forNew', token_hash_new: 'forCurrent' }));
  assert.deepEqual(mails.map((m) => m.to), ['old@example.com', 'new@example.com']);
  assert.match(mails[0].html, /token_hash=forCurrent/);
  assert.match(mails[1].html, /token_hash=forNew/);
  assert.match(mails[0].html, /old@example\.com.*new@example\.com/s);
});

test('Листи: без secure email change — один лист на нову адресу', () => {
  const mails = buildEmails(payload('email_change', { token_hash: 'only' }));
  assert.deepEqual(mails.map((m) => m.to), ['new@example.com']);
});

test('Листи: невідомі дії пропускаються, значення екрануються', () => {
  assert.deepEqual(buildEmails(payload('reauthentication')), []);
  assert.equal(render('<b>{{ .Email }}</b> {{ .Other }}', { Email: '<x>' }), '<b>&lt;x&gt;</b> {{ .Other }}');
  assert.equal(htmlToText('<p>Привіт&nbsp;<a href="https://a.b/?x=1&amp;y=2">тут</a></p>'), 'Привіт тут: https://a.b/?x=1&y=2\n');
});
