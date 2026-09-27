// Складання листів для Send Email Hook (без залежностей — перевіряється тестами в Node).
import { TEMPLATES } from './templates.js';

const escapeHtml = (value = '') => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Підставляє {{ .Змінна }} як у шаблонах Supabase (значення екрануються). */
export function render(template, vars) {
  return template.replace(/{{\s*\.(\w+)\s*}}/g, (match, name) => (name in vars ? escapeHtml(vars[name]) : match));
}

const decodeEntities = (text) => text
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&');

/** Текстова версія листа: антиспам не любить листи лише з HTML. */
export function htmlToText(html) {
  const text = html
    .replace(/<(head|title|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
      const clean = label.replace(/<[^>]+>/g, '').trim();
      return clean === href || decodeEntities(clean) === decodeEntities(href) ? href : `${clean}: ${href}`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h1|h2|tr|div|table)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

// Який шаблон і який type для посилання (?token_hash=…&type=…) на кожну дію Supabase Auth.
const ACTIONS = {
  signup: { template: 'confirm-signup', type: 'email' },
  email: { template: 'magic-link', type: 'email' },
  magiclink: { template: 'magic-link', type: 'email' },
  invite: { template: 'invite', type: 'invite' },
  recovery: { template: 'reset-password', type: 'recovery' },
  email_change: { template: 'change-email', type: 'email_change' },
};

function compose(templateName, to, vars) {
  const { subject, html } = TEMPLATES[templateName];
  const body = render(html, vars);
  return { to, subject, html: body, text: htmlToText(body) };
}

/**
 * Перетворює дані від Supabase ({ user, email_data }) на список листів { to, subject, html, text }.
 * Порожній список — для дій, яких застосунок не використовує.
 * siteUrl — адреса сайту. Поле email_data.site_url не годиться: там службова адреса Supabase (…supabase.co/auth/v1).
 */
export function buildEmails({ user, email_data: data }, siteUrl) {
  const action = ACTIONS[data.email_action_type];
  if (!action) return [];
  const base = { SiteURL: String(siteUrl).replace(/\/+$/, ''), Email: user.email, NewEmail: user.new_email ?? '' };

  if (data.email_action_type !== 'email_change') {
    return [compose(action.template, user.email, { ...base, TokenHash: data.token_hash })];
  }
  // Зміна пошти. Увага: назви полів «навпаки» (так у Supabase для сумісності):
  // token_hash_new — для ПОТОЧНОЇ адреси (user.email), token_hash — для НОВОЇ (user.new_email).
  const emails = [];
  if (data.token_hash_new) emails.push(compose(action.template, user.email, { ...base, TokenHash: data.token_hash_new }));
  if (data.token_hash) emails.push(compose(action.template, user.new_email, { ...base, TokenHash: data.token_hash }));
  return emails;
}
