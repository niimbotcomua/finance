// Сповіщення на пошту про нову витрату. Викликає сама база (тригер email_notify, міграція 018) через pg_net
// з секретом у заголовку X-Notify-Secret. Розгортається з verify_jwt = false.
// Секрети: NOTIFY_SECRET (той самий, що в private.email_notify), SMTP_PASSWORD.
import nodemailer from 'npm:nodemailer@6.9.16';
import { buildExpenseEmails } from './expense-email.js';

const SMTP_USER = Deno.env.get('SMTP_USER') ?? 'finance@chinnect24.com';
const SITE_URL = Deno.env.get('SITE_URL') ?? 'https://finance.chinnect24.com';
const transport = nodemailer.createTransport({
  host: Deno.env.get('SMTP_HOST') ?? 'mail.adm.tools',
  port: Number(Deno.env.get('SMTP_PORT') ?? 465),
  secure: true,
  auth: { user: SMTP_USER, pass: Deno.env.get('SMTP_PASSWORD') },
});
const FROM = { name: 'Спільні витрати', address: SMTP_USER };

async function sendAll(data: unknown) {
  for (const email of buildExpenseEmails(data, SITE_URL)) {
    try {
      await transport.sendMail({ from: FROM, ...email });
    } catch (err) {
      console.error('notify-expense:', email.to, err);
    }
  }
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('NOTIFY_SECRET');
  if (req.method !== 'POST' || !secret || req.headers.get('x-notify-secret') !== secret) {
    return new Response('forbidden', { status: 403 });
  }
  let data;
  try {
    data = await req.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }
  // Відповідаємо одразу (pg_net чекає лише кілька секунд), листи надсилаємо у фоні.
  EdgeRuntime.waitUntil(sendAll(data));
  return new Response('accepted', { status: 202 });
});
