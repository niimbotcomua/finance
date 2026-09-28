// Рендерить branding/og/og.html у public/og.png (1200×630). Потрібен Playwright з Chromium.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const src = new URL('./og.html', import.meta.url).href;
const out = fileURLToPath(new URL('../../public/og.png', import.meta.url));
const delay = Number(process.env.OG_DELAY_MS ?? 3000); // момент анімації сцени, який потрапить у кадр

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(src, { waitUntil: 'load' });
await page.waitForTimeout(delay);
await page.screenshot({ path: out });
await browser.close();
console.log(out);
