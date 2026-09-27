// Малює логотипи для шапки сайту (public/logos/<дизайн>.png) — по одному на кожен дизайн.
// Запуск: node scripts/build-logos.mjs (потрібен Playwright з Chromium).
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../public/logos/', import.meta.url));

// Кольори під кожен дизайн: тло шапки, купюра, коло з ₴, крильця, напис.
const THEMES = {
  dark: { bg: '#0d0d0f', note: '#ffffff', noteLine: '#ff6a5c', coin: 'url(#grad)', wings: ['#ffffff', '#ffd9cc', '#ffb89e'], text: '#ffffff', upper: false },
  nova: { bg: '#ffffff', note: '#ffffff', noteLine: '#da291c', coin: '#da291c', wings: ['#da291c', '#ec7a70', '#f5b8b2'], text: '#da291c', upper: true },
};

const icon = (t) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-234 -128 462 260" height="100%">
  <defs>
    <linearGradient id="grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff4f6d"/><stop offset="1" stop-color="#ff8a4c"/></linearGradient>
    <g id="wing">
      <rect x="-128" y="-15" width="140" height="30" rx="15" fill="${t.wings[0]}" transform="rotate(38)"/>
      <rect x="-108" y="-15" width="120" height="30" rx="15" fill="${t.wings[1]}" transform="rotate(16)"/>
      <rect x="-86" y="-15" width="98" height="30" rx="15" fill="${t.wings[2]}" transform="rotate(-6)"/>
    </g>
  </defs>
  <g transform="translate(0 22) rotate(-10)">
    <use href="#wing" transform="translate(-100 -20)"/>
    <use href="#wing" transform="translate(100 -20) scale(-1 1)"/>
    <rect x="-112" y="-66" width="224" height="132" rx="18" fill="${t.note}" stroke="${t.noteLine}" stroke-width="10"/>
    <rect x="-94" y="-48" width="188" height="96" rx="8" fill="none" stroke="${t.noteLine}" stroke-width="6" stroke-dasharray="2 11" stroke-linecap="round" opacity=".5"/>
    <circle r="44" fill="${t.coin}"/>
    <text y="21" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="62" font-weight="700" fill="#fff">₴</text>
  </g>
</svg>`;

const page = (t) => `<!doctype html><html><body style="margin:0;background:transparent">
<div id="logo" style="display:inline-flex;align-items:center;gap:6px;height:44px;padding:0 2px;
  font-family:'Liberation Sans',Arial,sans-serif;font-weight:700;color:${t.text};white-space:nowrap;
  font-size:${t.upper ? 22 : 24}px;letter-spacing:${t.upper ? '0.02em' : '-0.01em'}">
  <span style="height:44px;display:block">${icon(t)}</span>
  <span>${t.upper ? 'СПІЛЬНІ ВИТРАТИ' : 'Спільні витрати'}</span>
</div></body></html>`;

const browser = await chromium.launch();
const tab = await browser.newPage({ deviceScaleFactor: 3 });
for (const [name, t] of Object.entries(THEMES)) {
  await tab.setContent(page(t));
  await tab.locator('#logo').screenshot({ path: `${out}${name}.png`, omitBackground: true });
}
await browser.close();
