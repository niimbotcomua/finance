// Send Email Hook: Supabase Auth передає сюди листи замість власної відправки.
// Надсилаємо їх через SMTP хостингу (finance@chinnect24.com) за допомогою nodemailer — він додає Message-ID,
// коректні заголовки та текстову версію, яких бракувало листам від Supabase (через це вони йшли в спам).
// Секрети (Edge Functions → Secrets): SEND_EMAIL_HOOK_SECRET, SMTP_PASSWORD.
import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0';
import nodemailer from 'npm:nodemailer@6.9.16';
import { buildEmails } from './emails.js';

const SMTP_USER = Deno.env.get('SMTP_USER') ?? 'finance@chinnect24.com';
const transport = nodemailer.createTransport({
  host: Deno.env.get('SMTP_HOST') ?? 'mail.adm.tools',
  port: Number(Deno.env.get('SMTP_PORT') ?? 465),
  secure: true,
  auth: { user: SMTP_USER, pass: Deno.env.get('SMTP_PASSWORD') },
});
const FROM = { name: 'Спільні витрати', address: SMTP_USER };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: { http_code: 405, message: 'Method not allowed' } }, 405);
  const payload = await req.text();
  let data;
  try {
    const secret = (Deno.env.get('SEND_EMAIL_HOOK_SECRET') ?? '').replace('v1,whsec_', '');
    data = new Webhook(secret).verify(payload, Object.fromEntries(req.headers));
  } catch {
    return json({ error: { http_code: 401, message: 'Invalid signature' } }, 401);
  }
  try {
    const emails = buildEmails(data);
    if (!emails.length) console.warn('send-email: пропущено дію', data.email_data?.email_action_type);
    for (const email of emails) await transport.sendMail({ from: FROM, ...email });
    return json({});
  } catch (err) {
    console.error('send-email:', err);
    return json({ error: { http_code: 500, message: 'Не вдалося надіслати лист' } }, 500);
  }
});
