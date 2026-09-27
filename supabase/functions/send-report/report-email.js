// Лист зі звітом по групі (Excel у вкладенні).
import { emailLayout, escapeHtml, htmlToText, paragraph } from '../_shared/layout.js';

export function buildReportEmail({ groupName, groupId, periodLabel, senderName, siteUrl }) {
  const site = String(siteUrl).replace(/\/+$/, '');
  const html = emailLayout({
    siteUrl: site,
    title: 'Звіт по групі 📊',
    body: paragraph({ strong: senderName }, ' надсилає звіт по групі ', { strong: `«${groupName}»` },
      periodLabel ? ` (період: ${periodLabel})` : '', '.')
      + paragraph('Файл Excel — у вкладенні до цього листа: усі витрати, витрати кожного учасника, баланси й хто кому винен.'),
    button: { label: 'Відкрити групу', url: `${site}/#/groups/${groupId}` },
    note: `Відкрити в Google Таблицях: sheets.new → «Файл» → «Імпортувати» → «Завантажити». `
      + `Лист надіслано з <a href="${escapeHtml(site)}" style="color:#da291c;">${escapeHtml(site.replace(/^https?:\/\//, ''))}</a>.`,
  });
  return { subject: `Звіт по групі «${groupName}»`, html, text: htmlToText(html) };
}
