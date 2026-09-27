// Надсилає звіт по групі (Excel, зібраний у браузері) на пошту: собі або всім учасникам групи.
// Викликає сайт від імені користувача (verify_jwt = true); доступ до групи перевіряють правила бази (RLS).
// Секрет: SMTP_PASSWORD.
import nodemailer from 'npm:nodemailer@6.9.16';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildReportEmail } from './report-email.js';

const SMTP_USER = Deno.env.get('SMTP_USER') ?? 'finance@chinnect24.com';
const SITE_URL = Deno.env.get('SITE_URL') ?? 'https://finance.chinnect24.com';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const transport = nodemailer.createTransport({
  host: Deno.env.get('SMTP_HOST') ?? 'mail.adm.tools',
  port: Number(Deno.env.get('SMTP_PORT') ?? 465),
  secure: true,
  auth: { user: SMTP_USER, pass: Deno.env.get('SMTP_PASSWORD') },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fail = (message: string, status = 400) => reply({ error: message }, status);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('Method not allowed', 405);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail('Потрібно увійти', 401);

  let body;
  try {
    body = await req.json();
  } catch {
    return fail('Некоректний запит');
  }
  const { group_id: groupId, to, filename, content, period_label: periodLabel } = body ?? {};
  if (!Number.isInteger(groupId) || !['me', 'members'].includes(to) || typeof content !== 'string'
    || typeof filename !== 'string' || !filename.endsWith('.xlsx')) {
    return fail('Некоректний запит');
  }
  const file = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  if (file.length > MAX_FILE_BYTES) return fail('Звіт завеликий для пошти');

  // RLS: групу й учасників бачить лише учасник групи.
  const { data: group } = await supabase.from('groups').select('id, name').eq('id', groupId).maybeSingle();
  if (!group) return fail('Групу не знайдено', 404);
  const { data: me } = await supabase.from('profiles').select('name, email').eq('id', user.id).maybeSingle();
  let recipients = [me?.email ?? user.email];
  if (to === 'members') {
    const { data: members, error } = await supabase.from('group_members')
      .select('profiles(email)').eq('group_id', groupId);
    if (error) return fail('Не вдалося отримати учасників групи', 500);
    recipients = [...new Set(members.map((m) => m.profiles?.email).filter(Boolean))];
  }

  const email = buildReportEmail({
    groupName: group.name, groupId, periodLabel, senderName: me?.name ?? user.email, siteUrl: SITE_URL,
  });
  const failed = [];
  for (const address of recipients) {
    try {
      await transport.sendMail({
        from: { name: 'Спільні витрати', address: SMTP_USER },
        replyTo: me?.email ?? user.email,
        to: address,
        ...email,
        attachments: [{
          filename: filename.replace(/[\\/:*?"<>|]+/g, ' '),
          content: file,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }],
      });
    } catch (err) {
      console.error('send-report:', address, err);
      failed.push(address);
    }
  }
  if (failed.length === recipients.length) return fail('Не вдалося надіслати лист', 500);
  return reply({ sent: recipients.length - failed.length, failed: failed.length });
});
