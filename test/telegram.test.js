import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planExpenseMessage, CAPTION_LIMIT } from '../supabase/functions/notify-telegram/plan.js';

const buttons = { inline_keyboard: [[{ text: '🧾 Відкрити витрату', url: 'https://x/#/groups/1/expenses/2' }]] };
const base = { chatId: 555, text: '💸 <b>Нова витрата</b>', buttons };

test('Telegram: без фото — звичайне повідомлення з кнопками', () => {
  const steps = planExpenseMessage({ ...base, photoCount: 0 });
  assert.deepEqual(steps.map((s) => s.method), ['sendMessage']);
  assert.deepEqual(steps[0].params.reply_markup, buttons);
});

test('Telegram: одне фото — фото з підписом і кнопками в одному повідомленні', () => {
  const [step, ...rest] = planExpenseMessage({ ...base, photoCount: 1 });
  assert.equal(rest.length, 0);
  assert.equal(step.method, 'sendPhoto');
  assert.deepEqual(step.params.photo, { photo: 0 });
  assert.equal(step.params.caption, base.text);
  assert.equal(step.params.parse_mode, 'HTML');
  assert.deepEqual(step.params.reply_markup, buttons);
});

test('Telegram: два фото — альбом, під ним текст з кнопками', () => {
  const steps = planExpenseMessage({ ...base, photoCount: 2 });
  assert.deepEqual(steps.map((s) => s.method), ['sendMediaGroup', 'sendMessage']);
  assert.deepEqual(steps[0].params.media, [{ type: 'photo', media: { photo: 0 } }, { type: 'photo', media: { photo: 1 } }]);
  assert.equal(steps[0].params.disable_notification, true);
  assert.deepEqual(steps[1].params.reply_markup, buttons);
});

test('Telegram: задовгий текст не влазить у підпис — фото окремо, текст окремо', () => {
  const steps = planExpenseMessage({ ...base, text: 'x'.repeat(CAPTION_LIMIT + 1), photoCount: 1 });
  assert.deepEqual(steps.map((s) => s.method), ['sendPhoto', 'sendMessage']);
  assert.equal(steps[0].params.caption, undefined);
});
