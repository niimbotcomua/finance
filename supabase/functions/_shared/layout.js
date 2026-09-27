// Спільний вигляд службових листів (сповіщення, звіт) — у стилі шаблонів supabase/templates/.
// Без залежностей: перевіряється тестами в Node.
export { htmlToText } from '../send-email/emails.js';

export const escapeHtml = (value = '') => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const P = 'margin:0 0 12px;font-size:16px;line-height:1.6;color:#3a3a42;';

/** Абзац; частини — рядки (екрануються) або { strong: '…' }. */
export const paragraph = (...parts) =>
  `<p style="${P}">${parts.map((p) => (typeof p === 'string' ? escapeHtml(p) : `<strong>${escapeHtml(p.strong)}</strong>`)).join('')}</p>`;

/** Таблиця «назва — значення». */
export const details = (rows) => `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:4px 0 12px;">${
  rows.filter(([, value]) => value).map(([label, value]) =>
    `<tr><td style="padding:6px 12px 6px 0;font-size:14px;color:#8e8e96;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>`
    + `<td style="padding:6px 0;font-size:16px;color:#1c1c20;font-weight:600;">${escapeHtml(value)}</td></tr>`).join('')
}</table>`;

/** Повний лист: заголовок, вміст (готовий HTML), кнопка й примітка внизу. */
export function emailLayout({ title, body, button, note }) {
  const buttonHtml = button ? `
<tr><td align="center" style="padding:16px 32px 8px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td align="center" bgcolor="#ff4f6d" style="border-radius:999px;background:#ff4f6d;background-image:linear-gradient(135deg,#ff4f6d 0%,#ff8a4c 100%);">
<a href="${escapeHtml(button.url)}" style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(button.label)}</a>
</td></tr></table>
</td></tr>` : '';
  const noteHtml = note ? `
<tr><td style="padding:24px 32px 32px;font-size:13px;line-height:1.5;color:#8e8e96;">${note}</td></tr>` : '<tr><td style="padding:0 0 24px;"></td></tr>';
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f3f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1c1c20;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f3f6;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:20px;overflow:hidden;">
<tr><td style="height:6px;background:#ff4f6d;background-image:linear-gradient(135deg,#ff4f6d 0%,#ff8a4c 100%);font-size:6px;line-height:6px;">&nbsp;</td></tr>
<tr><td style="padding:32px 32px 8px;font-size:18px;font-weight:700;">💸 Спільні витрати</td></tr>
<tr><td style="padding:8px 32px 0;">
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;font-weight:700;color:#1c1c20;">${escapeHtml(title)}</h1>
${body}
</td></tr>${buttonHtml}${noteHtml}
</table>
<p style="margin:16px 0 0;font-size:12px;color:#8e8e96;">Спільні витрати · облік витрат з друзями, сусідами й колегами</p>
</td></tr>
</table>
</body>
</html>
`;
}
