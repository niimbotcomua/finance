// Збирає шаблони листів з supabase/templates/ у модуль для функції send-email.
// Запуск після зміни будь-якого шаблону чи теми: npm run build:emails
import { readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../supabase/templates/', import.meta.url);
const out = new URL('../supabase/functions/send-email/templates.js', import.meta.url);

/** Теми листів беремо з таблиці в README.md: | Шаблон | [`файл.html`](…) | Тема | */
export function readTemplates() {
  const readme = readFileSync(new URL('README.md', dir), 'utf8');
  const templates = {};
  for (const [, file, subject] of readme.matchAll(/^\|[^|]*\|\s*\[`([\w-]+)\.html`\][^|]*\|\s*([^|]+?)\s*\|$/gm)) {
    templates[file] = { subject, html: readFileSync(new URL(`${file}.html`, dir), 'utf8') };
  }
  return templates;
}

export function buildModule(templates = readTemplates()) {
  return '// Згенеровано scripts/build-email-templates.js з supabase/templates/ — не редагуйте вручну.\n'
    + `export const TEMPLATES = ${JSON.stringify(templates, null, 2)};\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(out, buildModule());
  console.log(`Записано ${out.pathname}`);
}
