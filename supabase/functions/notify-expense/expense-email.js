// Лист «Нова витрата в групі» (дані готує база: private.email_expense_payload, міграція 018).
import { details, emailLayout, escapeHtml, htmlToText, paragraph } from '../_shared/layout.js';

const formatDate = (iso) => (iso ? iso.split('-').reverse().join('.') : '');

export function buildExpenseEmails(data, siteUrl) {
  const site = String(siteUrl).replace(/\/+$/, '');
  const amount = data.original ? `${data.amount} (${data.original})` : data.amount;
  return (data.recipients ?? []).map((r) => {
    const html = emailLayout({
      siteUrl: site,
      title: 'Нова витрата 💸',
      body: paragraph('У групі ', { strong: `«${data.group_name}»` }, ' додали витрату.')
        + details([
          ['Що', data.description],
          ['Сума', amount],
          ['Дата', formatDate(data.date)],
          ['Заплатив(ла)', data.payer],
          ['Додав(ла)', data.author],
          ['Ваша витрата', r.share ?? 'вас немає серед тих, хто ділить цю витрату'],
        ]),
      button: { label: 'Відкрити групу', url: `${site}/#/groups/${data.group_id}` },
      note: `Ви отримали цей лист, бо ввімкнули сповіщення про нові витрати. Вимкнути можна в `
        + `<a href="${escapeHtml(site)}/#/profile" style="color:#da291c;">профілі</a>.`,
    });
    return {
      to: r.email,
      subject: `${data.description} — ${data.amount} · «${data.group_name}»`,
      html,
      text: htmlToText(html),
    };
  });
}
