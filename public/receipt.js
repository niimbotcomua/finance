// Розбір тексту квитанції (після розпізнавання з фото) на позиції «назва — сума».
// Розпізнавання неідеальне, тож правила прості й терпимі до помилок: це підказка, а не бухгалтерія.

// Службові рядки: податки, оплата, решта, знижки — не товари.
const SKIP_RE = /пдв|ндс|податок|акциз|решта|здача|готівк|картк|безгот|оплат|знижк|бонус|gotówk|płatn|\b(?:vat|ptu|tax|mwst|cash|card|change|discount|rabat|reszta|karta)\b/i;
// Рядок з підсумком чека.
const TOTAL_RE = /сума|разом|всього|до сплати|итого|\b(?:total|suma|razem|summe|gesamt|zu zahlen|totale)\b/i;
// Сума в кінці рядка: «25.50», «1 250,00», далі може бути валюта або літера податкової групи («А», «B», «*»).
const AMOUNT_AT_END_RE = /(-?\d{1,3}(?:[  ]\d{3})+|-?\d+)[.,](\d{2})\s*(?:грн\.?|uah|₴|pln|zł|zl|eur|€|chf|\$|[a-zа-яіїєґ])?\s*\*?\s*$/i;
// Кількість × ціна: «2 x 15.00», «1.000 х 25,50 =».
const QTY_RE = /\d+(?:[.,]\d+)?\s*[xх×*]\s*\d+[.,]\d{2}\s*=?/gi;
const QTY_LINE_RE = /^\s*\d+(?:[.,]\d+)?\s*(?:шт\.?|кг|л|szt\.?)?\s*[xх×*]\s*\d+[.,]\d{2}\s*$/i;

/** Виправляє типові помилки розпізнавання цифр: «12 ,50» → «12,50», «1O.00» → «10.00». */
function normalizeLine(line) {
  return line
    .replace(/(\d)[oOоО](?=\s*[\d.,])/g, '$10')
    .replace(/(\d)\s*([.,])\s*(\d{2})(?!\d)/g, '$1$2$3')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Прибирає з назви кількість×ціну, зайві символи та короткі «хвости». */
function cleanName(text) {
  return text
    .replace(QTY_RE, ' ')
    .replace(/[=:#|_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\d.,*-]+(?=\p{L})/u, '') // код товару на початку
    .replace(/\s+\p{L}$/u, '')            // одинока літера податкової групи в кінці
    .trim();
}

const letters = (s) => (s.match(/\p{L}/gu) ?? []).length;

/**
 * Текст квитанції → { items: [{ name, amount }], total }.
 * amount і total — у копійках; total — підсумок із чека, або сума позицій, якщо його не знайдено.
 */
export function parseReceipt(text) {
  const items = [];
  let total = null;
  let pendingName = '';

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = normalizeLine(raw);
    if (!line) continue;
    if (QTY_LINE_RE.test(line)) continue; // «2 x 15.00» окремим рядком — сума буде нижче

    const match = line.match(AMOUNT_AT_END_RE);
    if (!match) {
      // Рядок без суми — можливо, назва товару, а сума на наступному рядку.
      pendingName = letters(line) >= 2 && !SKIP_RE.test(line) && !TOTAL_RE.test(line) ? cleanName(line) : '';
      continue;
    }

    const whole = match[1].replace(/[  ]/g, '');
    const amount = Math.abs(Number(whole)) * 100 + Number(match[2]);
    const before = line.slice(0, match.index);

    if (SKIP_RE.test(before)) {
      pendingName = '';
      continue;
    }
    if (TOTAL_RE.test(before)) {
      if (amount > 0) total = amount;
      break; // після підсумку йдуть оплата, податки тощо
    }
    if (whole.startsWith('-') || amount === 0) {
      pendingName = '';
      continue;
    }

    let name = cleanName(before);
    if (letters(name) < 2) name = pendingName;
    pendingName = '';
    if (letters(name) < 2) continue; // сума без назви — найімовірніше, сміття розпізнавання
    items.push({ name: name.slice(0, 100), amount });
  }

  return { items, total: total ?? items.reduce((sum, item) => sum + item.amount, 0) };
}
