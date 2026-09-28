// Підставляє SEO-теги (назва, опис, картинка-прев'ю) у сторінку застосунку.
// Соцмережі (Telegram, Facebook, Viber…) не виконують JavaScript, тому теги мають бути в HTML одразу.

export const DEFAULT_META = {
  site_title: 'Спільні витрати — рахуйте витрати з друзями без сварок',
  site_description: 'Додавайте спільні витрати в поїздках, квартирі чи на вечірках — застосунок сам порахує, хто кому скільки винен. Фото чеків, різні валюти, запрошення за посиланням.',
  logo_path: null,
  og_image_path: null,
  design: 'dark',
};

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** Публічне посилання на файл зі сховища branding. */
export const brandingUrl = (supabaseUrl, path) =>
  `${supabaseUrl}/storage/v1/object/public/branding/${path.split('/').map(encodeURIComponent).join('/')}`;

/** Блок тегів для <head>. */
export function seoTags(meta, { origin, supabaseUrl }) {
  const m = { ...DEFAULT_META, ...Object.fromEntries(Object.entries(meta ?? {}).filter(([, v]) => v)) };
  const title = escapeHtml(m.site_title);
  const description = escapeHtml(m.site_description);
  const image = escapeHtml(m.og_image_path ? brandingUrl(supabaseUrl, m.og_image_path) : `${origin}/og.png?v=2`);
  const url = escapeHtml(`${origin}/`);
  return [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:locale" content="uk_UA">',
    `<meta property="og:site_name" content="${escapeHtml(String(m.site_title).split(' — ')[0])}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${image}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${image}">`,
  ].join('\n  ');
}

/** Замінює блок між <!-- seo:start --> і <!-- seo:end --> та вмикає збережений дизайн. */
export function renderPage(html, meta, options) {
  const design = meta?.design === 'dark' ? 'dark' : 'nova';
  return html
    .replace(/<!-- seo:start -->[\s\S]*?<!-- seo:end -->/, `<!-- seo:start -->\n  ${seoTags(meta, options)}\n  <!-- seo:end -->`)
    .replace('<html lang="uk">', `<html lang="uk" data-design="${design}">`);
}
