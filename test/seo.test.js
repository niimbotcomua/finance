import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderPage } from '../api/_seo.js';

const html = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const options = { origin: 'https://example.com', supabaseUrl: 'https://db.example.com' };

test('SEO: теги з налаштувань підставляються в сторінку й екрануються', () => {
  const page = renderPage(html, {
    site_title: 'Гроші <друзів>', site_description: 'Опис "з лапками"', og_image_path: 'og/1.jpg', design: 'dark',
  }, options);
  assert.match(page, /<title>Гроші &lt;друзів&gt;<\/title>/);
  assert.match(page, /<meta property="og:description" content="Опис &quot;з лапками&quot;">/);
  assert.match(page, /<meta property="og:image" content="https:\/\/db\.example\.com\/storage\/v1\/object\/public\/branding\/og\/1\.jpg">/);
  assert.match(page, /<html lang="uk" data-design="dark">/);
  assert.equal(page.match(/<title>/g).length, 1);
  assert.match(page, /<script type="module" src="\/app\.js"><\/script>/);
});

test('SEO: без налаштувань — типові тексти й картинка сайту', () => {
  const page = renderPage(html, null, options);
  assert.match(page, /<title>Спільні витрати/);
  assert.match(page, /<meta property="og:image" content="https:\/\/example\.com\/og\.png">/);
  assert.match(page, /data-design="nova"/);
});
