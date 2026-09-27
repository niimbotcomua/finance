// Спільний вигляд службових листів (сповіщення, звіт) — у стилі шаблонів supabase/templates/ (дизайн «Плитки»).
// Без залежностей: перевіряється тестами в Node.
export { htmlToText } from '../send-email/emails.js';

export const escapeHtml = (value = '') => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const P = 'margin:0 0 12px;font-size:16px;line-height:1.6;color:#3c3c44;';

/** Абзац; частини — рядки (екрануються) або { strong: '…' }. */
export const paragraph = (...parts) =>
  `<p style="${P}">${parts.map((p) => (typeof p === 'string' ? escapeHtml(p) : `<strong>${escapeHtml(p.strong)}</strong>`)).join('')}</p>`;

/** Таблиця «назва — значення». */
export const details = (rows) => `<table role="presentation" cellpadding="0" cellspacing="0" bgcolor="#f4f4f6" style="width:100%;margin:4px 0 12px;background:#f4f4f6;border-radius:8px;">${
  rows.filter(([, value]) => value).map(([label, value], i) =>
    `<tr><td style="padding:${i ? 4 : 14}px 12px 4px 16px;font-size:14px;color:#74747c;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>`
    + `<td style="padding:${i ? 4 : 14}px 16px 4px 0;font-size:16px;color:#1b1b1f;font-weight:600;">${escapeHtml(value)}</td></tr>`).join('')
}<tr><td colspan="2" style="height:10px;font-size:0;line-height:0;">&nbsp;</td></tr></table>`;

/** Логотип угорі листа (як у дизайні «Плитки»); без адреси сайту — назва червоними літерами. */
const logoHtml = (siteUrl) => (siteUrl
  ? `<img src="${escapeHtml(String(siteUrl).replace(/\/+$/, ''))}/logos/nova.png" width="214" height="32" alt="СПІЛЬНІ ВИТРАТИ" `
    + 'style="display:block;border:0;outline:none;height:32px;width:214px;color:#da291c;font-size:16px;font-weight:800;letter-spacing:0.02em;">'
  : '<span style="color:#da291c;font-size:16px;font-weight:800;letter-spacing:0.02em;">СПІЛЬНІ ВИТРАТИ</span>');

/** Повний лист (стиль «Плитки»): логотип, заголовок, вміст (готовий HTML), кнопка й примітка внизу. */
export function emailLayout({ title, body, button, note, siteUrl }) {
  const logo = logoHtml(siteUrl);
  const buttonHtml = button ? `
<tr><td align="center" style="padding:16px 32px 8px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td align="center" bgcolor="#da291c" style="border-radius:6px;background:#da291c;">
<a href="${escapeHtml(button.url)}" style="display:inline-block;padding:16px 36px;font-size:14px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(button.label)}</a>
</td></tr></table>
</td></tr>` : '';
  const noteHtml = note ? `
<tr><td style="padding:20px 32px 28px;font-size:13px;line-height:1.5;color:#74747c;">${note}</td></tr>` : '<tr><td style="padding:0 0 24px;"></td></tr>';
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1b1b1f;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e3e8;border-radius:8px;overflow:hidden;">
<tr><td style="padding:20px 32px;border-bottom:1px solid #e3e3e8;">${logo}</td></tr>
<tr><td style="padding:28px 32px 0;">
<h1 style="margin:0 0 16px;font-size:26px;line-height:1.25;font-weight:800;letter-spacing:-0.01em;color:#1b1b1f;">${escapeHtml(title)}</h1>
${body}
</td></tr>${buttonHtml}${noteHtml}
</table>
<p style="margin:16px 0 0;font-size:12px;color:#74747c;">Спільні витрати · облік витрат з друзями, сусідами й колегами</p>
</td></tr>
</table>
</body>
</html>
`;
}
