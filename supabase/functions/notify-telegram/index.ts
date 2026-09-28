// Сповіщення в Telegram про нову витрату — з фото квитанцій. Викликає сама база (тригер telegram_notify,
// міграція 029) через pg_net з секретом бота в заголовку X-Notify-Secret. Розгортається з verify_jwt = false.
// Фото прикріплюються до витрати одразу після її створення, тому чекаємо кілька секунд і лише тоді беремо
// з бази тексти, кнопки й фото (public.telegram_expense_notification).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { planExpenseMessage } from './plan.js';

const WAIT_FOR_PHOTOS_MS = 5000;
const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

type Photo = { blob: Blob; fileId?: string };

/** Підставляє фото в параметри кроку: уже завантажене в Telegram — за file_id, інакше — сам файл. */
function buildRequest(params: Record<string, unknown>, photos: Photo[]) {
  const form = new FormData();
  const attached: number[] = [];
  const ref = (value: { photo: number }) => {
    const photo = photos[value.photo];
    if (photo.fileId) return photo.fileId;
    form.append(`p${value.photo}`, photo.blob, `receipt-${value.photo + 1}.jpg`);
    attached.push(value.photo);
    return `attach://p${value.photo}`;
  };
  for (const [key, value] of Object.entries(params)) {
    let v: unknown = value;
    if (key === 'photo') v = ref(value as { photo: number });
    if (key === 'media') v = (value as { media: { photo: number } }[]).map((m) => ({ ...m, media: ref(m.media) }));
    form.append(key, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return { form, attached };
}

async function notify(expenseId: number, secret: string) {
  await new Promise((resolve) => setTimeout(resolve, WAIT_FOR_PHOTOS_MS));
  const { data, error } = await supabase.rpc('telegram_expense_notification', { secret, eid: expenseId });
  if (error || !data) return console.error('notify-telegram:', error?.message ?? 'витрату не знайдено');

  const photos: Photo[] = [];
  for (const path of data.photos as string[]) {
    const { data: blob, error: err } = await supabase.storage.from('receipts').download(path);
    if (blob) photos.push({ blob });
    else console.error('notify-telegram: фото', path, err?.message);
  }

  for (const { chat_id: chatId, text } of data.messages) {
    let failure: string | null = null;
    for (const step of planExpenseMessage({ chatId, text, buttons: data.buttons, photoCount: photos.length })) {
      const { form, attached } = buildRequest(step.params, photos);
      const res = await fetch(`https://api.telegram.org/bot${data.token}/${step.method}`, { method: 'POST', body: form });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        failure ??= String(body.description ?? `HTTP ${res.status}`);
        console.error('notify-telegram:', step.method, chatId, failure);
        continue;
      }
      // Щоб не завантажувати ті самі фото для кожного учасника — далі шлемо їх за file_id.
      const sent = Array.isArray(body.result) ? body.result : [body.result];
      attached.forEach((i, n) => {
        const sizes = sent[step.method === 'sendMediaGroup' ? i : n]?.photo;
        if (sizes?.length) photos[i].fileId = sizes[sizes.length - 1].file_id;
      });
    }
    // Для адмінки: чи дійшло повідомлення (напр. «bot was blocked by the user»).
    const { error: reportError } = await supabase.rpc('telegram_report_delivery', { secret, chat: chatId, ok: !failure, error: failure });
    if (reportError) console.error('notify-telegram: звіт про доставку', reportError.message);
  }
}

Deno.serve(async (req) => {
  const secret = req.headers.get('x-notify-secret') ?? '';
  if (req.method !== 'POST' || !secret) return new Response('forbidden', { status: 403 });
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }
  if (!Number.isInteger(body?.expense_id)) return new Response('bad request', { status: 400 });
  // Відповідаємо одразу (pg_net чекає лише кілька секунд), надсилаємо у фоні. Секрет перевіряє база.
  EdgeRuntime.waitUntil(notify(body.expense_id, secret).catch((err) => console.error('notify-telegram:', err)));
  return new Response('accepted', { status: 202 });
});
