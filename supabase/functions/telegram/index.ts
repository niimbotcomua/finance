// Вебхук Telegram-бота: сюди Telegram надсилає повідомлення, які люди пишуть боту (/start <код>, /stop).
// Уся логіка — у базі (public.telegram_webhook, міграція 017); тут лише передаємо запит і повертаємо
// відповідь Telegram-у (він сам надішле її в чат). Розгортається з verify_jwt = false: справжність запиту
// перевіряє секрет у заголовку X-Telegram-Bot-Api-Secret-Token.
import { createClient } from 'npm:@supabase/supabase-js@2';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok');
  let payload;
  try {
    payload = await req.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }
  const secret = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
  const { data, error } = await supabase.rpc('telegram_webhook', { secret, payload });
  if (error) {
    if (error.message.includes('forbidden')) return new Response('forbidden', { status: 403 });
    console.error(error.message);
    return new Response('ok'); // інакше Telegram повторюватиме той самий запит
  }
  return data
    ? new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
    : new Response('ok');
});
