// Головна сторінка (/) з SEO-тегами з налаштувань адміністратора (див. api/_seo.js).
import { readFile } from 'node:fs/promises';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../public/config.js';
import { renderPage } from './_seo.js';

let template = null;
async function loadTemplate() {
  if (template) return template;
  const candidates = [new URL('../public/app.html', import.meta.url), `${process.cwd()}/public/app.html`];
  for (const path of candidates) {
    try {
      template = await readFile(path, 'utf8');
      return template;
    } catch {
      // пробуємо наступний шлях
    }
  }
  throw new Error('app.html не знайдено');
}

async function loadMeta() {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/site_meta`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const rows = await response.json();
    return Array.isArray(rows) ? rows[0] : rows;
  } catch {
    return null; // база недоступна — віддаємо сторінку з типовими тегами
  }
}

export default async function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = `https://${host}`;
  const [html, meta] = await Promise.all([loadTemplate(), loadMeta()]);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Кешуємо на CDN 5 хвилин: зміни в адмінці з'являються в прев'ю за кілька хвилин.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400');
  res.status(200).send(renderPage(html, meta, { origin, supabaseUrl: SUPABASE_URL }));
}
