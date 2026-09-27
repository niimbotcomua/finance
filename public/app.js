// Клієнтська частина: невеликий SPA без фреймворків; дані зберігаються в Supabase.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { computeBalances, convertAmount, convertShares, remainderShare, simplifyDebts, splitEqually } from './balances.js';
import { filterByPeriod, summarize } from './analytics.js';
import { REPORT_PERIODS, buildPdfDoc, buildReport, writeWorkbook } from './report.js';
import { FILTER_PERIODS, GROUP_BALANCE_FILTERS, filterExpenses, filterGroups, isFiltered } from './filters.js';

// Посилання «Створити новий пароль» з листа повертає людину з #…&type=recovery; запам'ятовуємо це до того,
// як клієнт Supabase обробить і прибере токен з адреси.
let passwordRecovery = new URLSearchParams(location.hash.slice(1)).get('type') === 'recovery';

const configured = SUPABASE_URL.startsWith('https://') && !SUPABASE_ANON_KEY.includes('ВСТАВТЕ');
const supabase = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const app = document.getElementById('app');
const userbox = document.getElementById('userbox');
const toastEl = document.getElementById('toast');
const tabbar = document.getElementById('tabbar');

let currentUser = null;

// ---------- Версія дизайну ----------
// Загальний дизайн обирає адміністратор (app_settings.design), але кожен користувач може вибрати свій у профілі
// (profiles.design). Останній застосований дизайн пам'ятаємо в браузері, щоб сторінка не «блимала».
const DESIGNS = {
  dark: { label: 'Темний', note: 'Початковий: темний фон, рожево-помаранчеві акценти.' },
  mono: { label: 'Світлий', note: 'У стилі monobank: градієнт угорі, білі картки, чорні кнопки.' },
  nova: { label: 'Плитки', note: 'У стилі «Нової пошти»: мінімалізм, сірі плитки, червоні кнопки.' },
};
function applyDesign(design) {
  const value = DESIGNS[design] ? design : 'dark';
  document.documentElement.dataset.design = value;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', { mono: '#ffffff', nova: '#ffffff' }[value] ?? '#0d0d0f');
  try {
    localStorage.setItem('design', value);
  } catch {
    // сховище недоступне (приватний режим) — не страшно
  }
}
try {
  applyDesign(localStorage.getItem('design'));
} catch {
  applyDesign('dark');
}
let siteDesign = null; // обраний адміністратором для всіх
let userDesign = null; // власний вибір користувача (null — як у всіх)
/** Застосовує дизайн: власний вибір користувача, інакше — загальний. */
function refreshDesign() {
  const design = userDesign ?? siteDesign;
  if (design) applyDesign(design);
  if (typeof renderBrand === 'function' && document.querySelector('.topbar .brand')) {
    try { renderBrand(); } catch { /* шапка ще не готова */ }
  }
}

// ---------- Утиліти ----------

/** Створює DOM-елемент. Текст завжди вставляється як textContent (захист від XSS). */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Основна валюта відкритої групи — у ній показуємо баланси, борги й аналітику.
let baseCurrency = 'UAH';
const moneyFormats = new Map();
function moneyFormat(currency) {
  if (!moneyFormats.has(currency)) {
    moneyFormats.set(currency, new Intl.NumberFormat('uk-UA', {
      style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
      currencyDisplay: currency === 'UAH' ? 'symbol' : 'narrowSymbol', // гривня — «грн», решта — «$», «€», «zł»…
    }));
  }
  return moneyFormats.get(currency);
}
/** Сума в сотих частках → «1 234,50 грн» (за замовчуванням — в основній валюті групи). */
const formatMoney = (kopecks, currency = baseCurrency) => moneyFormat(currency).format(kopecks / 100);
/** Велика сума: гривні крупно, копійки й знак валюти — дрібніше (як у mono). */
function bigMoney(kopecks, currency) {
  const parts = moneyFormat(currency).formatToParts(kopecks / 100);
  const cut = parts.findIndex((p) => p.type === 'decimal');
  const head = parts.slice(0, cut === -1 ? parts.length : cut).map((p) => p.value).join('');
  const tail = cut === -1 ? '' : parts.slice(cut).map((p) => p.value).join('');
  return h('span', { class: 'big-money' }, head, h('span', { class: 'cents' }, tail));
}
const currencySymbol = (currency) => moneyFormat(currency).formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency;

/** Довідник валют (завантажується один раз). */
let currencyList = null;
async function loadCurrencies() {
  currencyList ??= await run(supabase.from('currencies').select('code, name, flag').order('sort_order'));
  return currencyList;
}
const currencyInfo = (code) => currencyList?.find((c) => c.code === code) ?? { code, name: code, flag: '' };
const currencyLabel = (code) => `${currencyInfo(code).flag} ${code}`.trim();

/** Курс «41,25» → 41.25; null, якщо некоректно. */
function parseRate(value) {
  const normalized = String(value).trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,8})?$/.test(normalized)) return null;
  const rate = Number(normalized);
  return rate > 0 && rate < 1000000 ? rate : null;
}
const formatRate = (rate) => Number(rate).toLocaleString('uk-UA', { maximumFractionDigits: 6 });
const formatDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('uk-UA');
const today = () => new Date().toISOString().slice(0, 10);

/** "12,50" → 1250 копійок; null, якщо некоректно. */
function parseMoney(value) {
  const normalized = String(value).trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, frac = ''] = normalized.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** 3050 копійок → "30,50" (3000 → "30") — для підстановки в поле вводу. */
const formatInput = (kopecks) => (kopecks / 100).toFixed(2).replace('.', ',').replace(/,00$/, '');

const avatarUrl = (path) => supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;

/** Кружечок з фото профілю або першою літерою імені. */
function avatar(profile, size = 'sm') {
  const cls = `avatar avatar-${size}${profile?.id && profile.id === currentUser?.id ? ' avatar-me' : ''}`;
  if (profile?.avatar_path) return h('img', { class: cls, src: avatarUrl(profile.avatar_path), alt: '' });
  return h('span', { class: cls, 'aria-hidden': 'true' }, (profile?.name ?? '?').trim().charAt(0).toUpperCase() || '?');
}

const categoryLabel = (c) => (c.icon ? `${c.icon} ${c.name}` : c.name);

/** Замінює вміст #app, пропускаючи порожні (null/false) вузли. */
function mount(...nodes) {
  app.replaceChildren(...nodes.filter((n) => n !== null && n !== undefined && n !== false));
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (toastEl.hidden = true), 3000);
}

const ERROR_TRANSLATIONS = {
  'Invalid login credentials': 'Невірний email або пароль',
  'User already registered': 'Користувач з таким email вже існує',
  'Email not confirmed': 'Спершу підтвердіть email — перейдіть за посиланням у листі',
  'Password should be at least': 'Пароль занадто короткий (мінімум 8 символів)',
  'should be different from the old password': 'Новий пароль має відрізнятися від старого',
  'only request this after': 'Лист уже надіслано — зачекайте хвилину перед повторною спробою',
  'rate limit': 'Забагато спроб, спробуйте трохи пізніше',
  'row-level security': 'Недостатньо прав для цієї дії',
};

function translateError(message = '') {
  const key = Object.keys(ERROR_TRANSLATIONS).find((k) => message.includes(k));
  return key ? ERROR_TRANSLATIONS[key] : message || 'Щось пішло не так';
}

/** Розпаковує відповідь Supabase: повертає data або кидає помилку українською. */
async function run(request) {
  const { data, error } = await request;
  if (error) throw new Error(translateError(error.message));
  return data;
}

// Запрошення, яке треба прийняти після входу (переживає реєстрацію та перехід за посиланням з листа).
const PENDING_INVITE_KEY = 'pendingInvite';
const pendingInvite = {
  get() {
    try { return localStorage.getItem(PENDING_INVITE_KEY); } catch { return null; }
  },
  set(token) {
    try { localStorage.setItem(PENDING_INVITE_KEY, token); } catch { /* недоступно — просто без запам'ятовування */ }
  },
  clear() {
    try { localStorage.removeItem(PENDING_INVITE_KEY); } catch { /* ігноруємо */ }
  },
};

const inviteLink = (token) => `${location.origin}${location.pathname}#/join/${token}`;

async function loadCurrentUser() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const [profile, isAdmin, settings] = await Promise.all([
    run(supabase.from('profiles').select('id, name, email, avatar_path, design').eq('id', session.user.id).maybeSingle()),
    run(supabase.rpc('am_i_admin')).catch(() => false),
    run(supabase.from('app_settings').select('design').maybeSingle()).catch(() => null),
  ]);
  if (settings?.design) siteDesign = settings.design;
  userDesign = profile?.design ?? null;
  refreshDesign();
  return { ...(profile ?? { id: session.user.id, email: session.user.email, name: session.user.email }), isAdmin };
}

/** Обробник форми з блокуванням кнопки та показом помилки. */
function submitHandler(form, errorEl, action) {
  return async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    errorEl.textContent = '';
    button.disabled = true;
    try {
      await action(new FormData(form));
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  };
}

// ---------- Шапка ----------

/** Назва, опис, логотип сайту (налаштовує адмін). Доступно й до входу. */
let siteMeta = null;
let siteLogos = {}; // окремий логотип для кожного дизайну: { dark, mono, nova }
const brandingUrl = (path) => supabase.storage.from('branding').getPublicUrl(path).data.publicUrl;
const logoFor = (design) => siteLogos?.[design] ?? siteMeta?.logo_path ?? null;

function renderBrand() {
  const brand = document.querySelector('.topbar .brand');
  if (!brand) return;
  const logo = logoFor(document.documentElement.dataset.design);
  if (logo) {
    brand.replaceChildren(h('img', { class: 'brand-logo', src: brandingUrl(logo), alt: siteMeta?.site_title ?? 'Логотип' }));
  } else {
    brand.replaceChildren('💸 Спільні витрати');
  }
}

async function loadSiteMeta() {
  try {
    const [rows, logos] = await Promise.all([run(supabase.rpc('site_meta')), run(supabase.rpc('site_logos')).catch(() => ({}))]);
    siteMeta = Array.isArray(rows) ? rows[0] ?? null : rows;
    siteLogos = logos ?? {};
  } catch {
    siteMeta = null;
  }
  if (siteMeta?.design) siteDesign = siteMeta.design;
  refreshDesign();
  renderBrand();
}

function renderUserbox() {
  userbox.replaceChildren();
  if (!currentUser) return;
  userbox.append(
    h('a', { href: '#/profile', class: 'me', title: 'Мій профіль' }, avatar(currentUser), h('span', { class: 'me-name' }, currentUser.name)),
    h('button', {
      class: 'secondary',
      onClick: async () => {
        await supabase.auth.signOut();
        currentUser = null;
        userDesign = null;
        refreshDesign();
        renderUserbox();
        location.hash = '#/login';
      },
    }, 'Вийти'),
  );
}

// ---------- Нижня панель розділів ----------

// Прості лінійні значки (статичні рядки, без даних користувача).
const TAB_ICONS = {
  groups: '<path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1"/><circle cx="9" cy="7" r="3.5"/><path d="M22 19v-1a4 4 0 0 0-3-3.87M16 3.13a3.5 3.5 0 0 1 0 6.75"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  admin: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/>',
};

function tabIcon(name) {
  const icon = h('span', { class: 'tab-icon', 'aria-hidden': 'true' });
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${TAB_ICONS[name]}</svg>`;
  return icon;
}

function renderTabbar(hash) {
  const tabs = [
    { key: 'groups', href: '#/', label: 'Групи', active: hash === '#/' || hash.startsWith('#/groups/') },
    { key: 'archive', href: '#/archive', label: 'Архів', active: hash === '#/archive' },
    { key: 'profile', href: '#/profile', label: 'Профіль', active: hash === '#/profile' },
    currentUser?.isAdmin && { key: 'admin', href: '#/admin', label: 'Адмінка', active: hash === '#/admin' },
  ].filter(Boolean);
  tabbar.hidden = !currentUser;
  document.body.classList.toggle('has-tabbar', Boolean(currentUser));
  tabbar.replaceChildren(...tabs.map((t) =>
    h('a', { href: t.href, class: t.active ? 'tab active' : 'tab', 'aria-current': t.active ? 'page' : null },
      tabIcon(t.key), h('span', {}, t.label))));
}

// ---------- Мій профіль ----------

/** Обрізає фото до квадрата 256×256 і стискає в JPEG — щоб завантаження було швидким. */
async function squareJpeg(file, size = 256) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Не вдалося відкрити фото. Спробуйте файл JPG або PNG.');
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = h('canvas', { width: size, height: size });
  canvas.getContext('2d').drawImage(
    bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size,
  );
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Не вдалося обробити фото'))), 'image/jpeg', 0.85));
}

/**
 * Вписує картинку в рамку width×height. fit = 'contain' — ціла картинка на прозорому тлі (логотип, PNG),
 * 'cover' — заповнює рамку з обрізанням країв (прев'ю для соцмереж, JPEG).
 */
async function framedImage(file, width, height, fit) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Не вдалося відкрити картинку. Спробуйте файл PNG або JPG.');
  }
  const scale = fit === 'cover'
    ? Math.max(width / bitmap.width, height / bitmap.height)
    : Math.min(width / bitmap.width, height / bitmap.height);
  const w = bitmap.width * scale;
  const h2 = bitmap.height * scale;
  const canvas = h('canvas', { width, height });
  const ctx = canvas.getContext('2d');
  if (fit === 'cover') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(bitmap, (width - w) / 2, (height - h2) / 2, w, h2);
  const type = fit === 'cover' ? 'image/jpeg' : 'image/png';
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Не вдалося обробити картинку'))), type, 0.9));
}

/** Зменшує фото так, щоб довша сторона була не більше maxSide, і стискає в JPEG. */
async function scaledJpeg(file, maxSide = 1600) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Не вдалося відкрити фото. Спробуйте файл JPG або PNG.');
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = h('canvas', { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Не вдалося обробити фото'))), 'image/jpeg', 0.85));
}

// ---------- Карусель фото ----------

/**
 * Фото на всю ширину; якщо їх кілька — гортаються свайпом (або стрілками на комп'ютері), внизу крапки.
 * slides: [{ src, onRemove? }] — onRemove додає на фото кнопку ✕.
 */
function photoCarousel(slides) {
  const track = h('div', { class: 'carousel-track' },
    slides.map((slide, i) => h('div', { class: 'carousel-slide' },
      h('a', { href: slide.src, target: '_blank', rel: 'noopener', title: 'Відкрити повністю' },
        h('img', { src: slide.src, alt: `Фото ${i + 1}`, loading: 'lazy' })),
      slide.onRemove && h('button', {
        type: 'button', class: 'photo-remove', title: 'Прибрати фото', 'aria-label': 'Прибрати фото', onClick: slide.onRemove,
      }, '✕'))));
  if (slides.length < 2) return h('div', { class: 'carousel' }, track);

  const dots = slides.map((_, i) => h('button', {
    type: 'button', class: 'carousel-dot', 'aria-label': `Фото ${i + 1}`, onClick: () => go(i),
  }));
  const counter = h('span', { class: 'carousel-counter' });
  const go = (i) => track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' });
  const current = () => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  const update = () => {
    const i = current();
    dots.forEach((dot, k) => dot.classList.toggle('active', k === i));
    counter.textContent = `${i + 1} / ${slides.length}`;
  };
  track.addEventListener('scroll', update, { passive: true });
  update();
  return h('div', { class: 'carousel' },
    track,
    counter,
    h('button', { type: 'button', class: 'carousel-arrow prev', 'aria-label': 'Попереднє фото', onClick: () => go(Math.max(0, current() - 1)) }, '‹'),
    h('button', { type: 'button', class: 'carousel-arrow next', 'aria-label': 'Наступне фото', onClick: () => go(Math.min(slides.length - 1, current() + 1)) }, '›'),
    h('div', { class: 'carousel-dots' }, dots),
  );
}

async function setAvatar(file) {
  const oldPath = currentUser.avatar_path;
  let newPath = null;
  if (file) {
    newPath = `${currentUser.id}/${Date.now()}.jpg`;
    await run(supabase.storage.from('avatars').upload(newPath, await squareJpeg(file), { contentType: 'image/jpeg' }));
  }
  await run(supabase.from('profiles').update({ avatar_path: newPath }).eq('id', currentUser.id));
  if (oldPath) await supabase.storage.from('avatars').remove([oldPath]); // старе фото більше не потрібне
  currentUser.avatar_path = newPath;
  renderUserbox();
}

function renderProfile() {
  const photoError = h('div', { class: 'error' });
  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const photoButtons = h('div', { class: 'actions' });

  const busy = async (button, action) => {
    photoError.textContent = '';
    button.disabled = true;
    try {
      await action();
      renderProfile();
    } catch (err) {
      photoError.textContent = err.message;
      button.disabled = false;
    }
  };
  const uploadButton = h('button', { type: 'button', onClick: () => fileInput.click() },
    currentUser.avatar_path ? 'Змінити фото' : 'Завантажити фото');
  fileInput.addEventListener('change', () => {
    const [file] = fileInput.files;
    if (file) busy(uploadButton, async () => { await setAvatar(file); toast('Фото оновлено'); });
  });
  photoButtons.append(uploadButton);
  if (currentUser.avatar_path) {
    const removeButton = h('button', {
      type: 'button',
      class: 'secondary',
      onClick: () => {
        if (confirm('Видалити фото профілю?')) busy(removeButton, () => setAvatar(null));
      },
    }, 'Видалити фото');
    photoButtons.append(removeButton);
  }

  const nameError = h('div', { class: 'error' });
  const nameForm = h('form', {},
    h('label', {}, "Ім'я", h('input', { name: 'name', value: currentUser.name, required: true, maxLength: 80 })),
    h('label', {}, 'Email', h('input', { value: currentUser.email, readOnly: true, disabled: true })),
    nameError,
    h('button', { type: 'submit' }, 'Зберегти'),
  );
  nameForm.addEventListener('submit', submitHandler(nameForm, nameError, async (data) => {
    const name = String(data.get('name')).trim();
    if (!name) throw new Error("Вкажіть ім'я");
    await run(supabase.from('profiles').update({ name }).eq('id', currentUser.id));
    currentUser.name = name;
    renderUserbox();
    toast("Ім'я збережено");
  }));

  mount(
    h('p', {}, h('a', { href: '#/' }, '← Усі групи')),
    h('h1', {}, 'Мій профіль'),
    h('div', { class: 'card profile-photo' },
      avatar(currentUser, 'lg'),
      h('div', {},
        h('h2', {}, 'Фото'),
        h('p', { class: 'sub' }, 'Його бачать учасники ваших груп.'),
        photoButtons,
        fileInput,
        photoError,
      ),
    ),
    h('div', { class: 'card' }, h('h2', {}, 'Дані'), nameForm),
    designChoiceCard(),
  );
}

/** Профіль: власний дизайн або «як у всіх» (обраний адміністратором). */
function designChoiceCard() {
  const options = h('div', { class: 'design-options' });
  const save = async (value, button) => {
    button.disabled = true;
    try {
      await run(supabase.from('profiles').update({ design: value }).eq('id', currentUser.id));
      userDesign = value;
      currentUser.design = value;
      refreshDesign();
      toast(value ? `Дизайн «${DESIGNS[value].label}» — для вас` : 'Тепер дизайн як у всіх');
    } catch (err) {
      toast(err.message);
    }
    render();
  };
  const option = (value, label, note, previewKey) => h('button', {
    type: 'button',
    class: `design-option${userDesign === value ? ' active' : ''}`,
    'aria-pressed': String(userDesign === value),
    onClick: (e) => save(value, e.currentTarget),
  },
  h('span', { class: `design-preview design-preview-${previewKey}`, 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
  h('span', { class: 'design-name' }, label),
  h('span', { class: 'sub' }, note));
  function render() {
    const common = DESIGNS[siteDesign ?? 'dark'];
    options.replaceChildren(
      option(null, 'Як у всіх', `Зараз це «${common.label}» — його обирає адміністратор.`, siteDesign ?? 'dark'),
      ...Object.entries(DESIGNS).map(([key, d]) => option(key, d.label, d.note, key)),
    );
  }
  render();
  return h('div', { class: 'card' },
    h('h2', {}, 'Дизайн'),
    h('p', { class: 'sub' }, 'Лише для вас: інші користувачі бачать свій вибір.'),
    options);
}

// ---------- Адмінка ----------

const TAG_ICONS = [
  '🛒', '🍎', '🥖', '🍽️', '☕', '🍕', '🍔', '🍺', '🍷', '🍰',
  '🚕', '🚌', '🚗', '⛽', '🅿️', '✈️', '🚆', '🏨', '🏠', '🛋️',
  '💡', '💧', '🔥', '📶', '📱', '💻', '🎉', '🎬', '🎮', '🎵',
  '🎁', '🎾', '🏓', '⚽', '🏋️', '🧘', '🏊', '🚴', '💊', '🏥',
  '💇', '🧴', '👕', '👟', '🛍️', '📚', '🎓', '🐶', '👶', '🧹',
  '🔧', '💼', '💳', '🏦', '🧾', '📦',
];

/** Кнопка зі значком тегу, що відкриває сітку емодзі; значення — у прихованому полі name="icon". */
function iconPicker(initial = '') {
  const input = h('input', { type: 'hidden', name: 'icon', value: initial });
  const button = h('button', {
    type: 'button', class: 'secondary icon-button', 'aria-haspopup': 'true', 'aria-expanded': 'false',
    title: 'Вибрати значок',
  });
  const grid = h('div', { class: 'icon-grid', hidden: true, role: 'listbox', 'aria-label': 'Значки' });
  const wrap = h('div', { class: 'icon-picker' }, input, button, grid);
  const show = () => { button.textContent = input.value || '＋'; };
  const close = () => { grid.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  const choose = (icon) => {
    input.value = icon;
    show();
    close();
    button.focus();
    wrap.dispatchEvent(new Event('change', { bubbles: true }));
  };
  grid.append(
    ...TAG_ICONS.map((icon) => h('button', {
      type: 'button', class: icon === initial ? 'icon-option selected' : 'icon-option', role: 'option',
      'aria-selected': String(icon === initial), onClick: () => choose(icon),
    }, icon)),
    h('button', { type: 'button', class: 'icon-option none', onClick: () => choose(''), title: 'Без значка' }, 'Без значка'),
  );
  button.addEventListener('click', () => {
    const opening = grid.hidden;
    document.querySelectorAll('.icon-grid').forEach((g) => { g.hidden = true; });
    grid.hidden = !opening;
    button.setAttribute('aria-expanded', String(opening));
  });
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  show();
  return wrap;
}

// Клік поза вибором значка закриває його.
document.addEventListener('click', (e) => {
  if (!e.target.closest?.('.icon-picker')) document.querySelectorAll('.icon-grid').forEach((g) => { g.hidden = true; });
});

async function renderAdmin() {
  if (!currentUser.isAdmin) throw new Error('Цей розділ доступний лише адміністратору');
  const [categories, users, currencies, settings] = await Promise.all([
    run(supabase.from('categories').select('id, name, icon, sort_order').order('sort_order').order('id')),
    run(supabase.rpc('admin_users')),
    loadCurrencies(),
    run(supabase.from('app_settings').select('default_currency').maybeSingle()),
  ]);
  const reload = () => renderAdmin().catch((err) => toast(err.message));

  const addError = h('div', { class: 'error' });
  const addForm = h('form', {},
    h('div', { class: 'row tag-row' },
      iconPicker(),
      h('input', { name: 'name', placeholder: 'Назва тегу, напр. «Спорт»', required: true, maxLength: 40 }),
      h('button', { type: 'submit' }, 'Додати'),
    ),
    addError,
  );
  addForm.addEventListener('submit', submitHandler(addForm, addError, async (data) => {
    await run(supabase.from('categories').insert({
      name: String(data.get('name')).trim(),
      icon: String(data.get('icon')).trim(),
      sort_order: Math.max(0, ...categories.map((c) => c.sort_order)) + 1,
    }));
    toast('Тег додано');
    reload();
  }));

  // Переміщення тегу вгору/вниз: зберігаємо весь новий порядок одним запитом.
  const move = async (index, delta) => {
    const ids = categories.map((c) => c.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    try {
      await run(supabase.rpc('admin_reorder_categories', { ids }));
      reload();
    } catch (err) {
      toast(err.message);
    }
  };

  const tagRow = (c, index) => {
    const error = h('div', { class: 'error' });
    const saveButton = h('button', { type: 'submit', class: 'secondary save-tag', title: 'Зберегти', 'aria-label': 'Зберегти' }, '✓');
    const form = h('form', {},
      h('div', { class: 'row tag-row' },
        h('div', { class: 'order' },
          h('button', { type: 'button', class: 'link', title: 'Вище', disabled: index === 0, onClick: () => move(index, -1) }, '▲'),
          h('button', {
            type: 'button', class: 'link', title: 'Нижче', disabled: index === categories.length - 1, onClick: () => move(index, 1),
          }, '▼'),
        ),
        iconPicker(c.icon),
        h('input', { name: 'name', value: c.name, required: true, maxLength: 40, 'aria-label': 'Назва' }),
        h('div', { class: 'actions' },
          saveButton,
          h('button', {
            type: 'button',
            class: 'link',
            title: 'Видалити тег',
            onClick: async () => {
              if (!confirm(`Видалити тег «${c.name}»? Витрати з ним залишаться, але без тегу.`)) return;
              try {
                await run(supabase.from('categories').delete().eq('id', c.id));
                reload();
              } catch (err) {
                error.textContent = err.message;
              }
            },
          }, '✕'),
        ),
      ),
      error,
    );
    form.addEventListener('submit', submitHandler(form, error, async (data) => {
      await run(supabase.from('categories').update({
        name: String(data.get('name')).trim(),
        icon: String(data.get('icon')).trim(),
      }).eq('id', c.id));
      toast('Збережено');
      saveButton.classList.remove('dirty');
    }));
    // Підсвічуємо «Зберегти», коли є незбережені зміни (зокрема новий значок).
    const markDirty = () => saveButton.classList.add('dirty');
    form.addEventListener('input', markDirty);
    form.addEventListener('change', markDirty);
    return h('li', {}, form);
  };

  const userRow = (u) => h('li', {},
    h('div', { class: 'person' },
      avatar(u),
      h('div', {},
        h('div', {}, u.name, u.is_admin ? h('span', { class: 'badge' }, 'адмін') : null),
        h('div', { class: 'sub' },
          `${u.email} · з ${new Date(u.created_at).toLocaleDateString('uk-UA')} · груп: ${u.group_count} · витрат: ${u.expense_count}`),
      ),
    ),
    u.id !== currentUser.id && h('button', {
      class: 'secondary',
      onClick: async () => {
        const question = u.is_admin ? `Забрати в ${u.name} права адміністратора?` : `Зробити ${u.name} адміністратором?`;
        if (!confirm(question)) return;
        try {
          await run(supabase.rpc('admin_set_admin', { target: u.id, make_admin: !u.is_admin }));
          reload();
        } catch (err) {
          toast(err.message);
        }
      },
    }, u.is_admin ? 'Забрати адміна' : 'Зробити адміном'),
  );

  // Валюта, яку форма «Нова група» пропонує першою.
  const currencyError = h('div', { class: 'error' });
  const currencyForm = h('form', {},
    h('div', { class: 'inline-form' },
      h('select', { name: 'currency', 'aria-label': 'Валюта за замовчуванням' },
        currencies.map((c) => h('option', { value: c.code, selected: c.code === settings?.default_currency }, `${c.flag} ${c.code} — ${c.name}`))),
      h('button', { type: 'submit' }, 'Зберегти'),
    ),
    currencyError,
  );
  currencyForm.addEventListener('submit', submitHandler(currencyForm, currencyError, async (data) => {
    await run(supabase.rpc('admin_set_default_currency', { currency: data.get('currency') }));
    toast('Валюту за замовчуванням збережено');
  }));

  await loadSiteMeta(); // свіжі назва, опис і логотипи дизайнів
  const brandingCard = brandingSettingsCard(siteMeta);

  // Перемикач версії дизайну — одразу для всіх користувачів.
  const designOptions = h('div', { class: 'design-options' });
  const renderDesignOptions = () => designOptions.replaceChildren(...Object.entries(DESIGNS).map(([key, d]) =>
    h('button', {
      type: 'button',
      class: `design-option${(siteDesign ?? 'dark') === key ? ' active' : ''}`,
      'aria-pressed': String((siteDesign ?? 'dark') === key),
      onClick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          await run(supabase.rpc('admin_set_design', { design: key }));
          siteDesign = key;
          refreshDesign();
          toast(userDesign
            ? `Дизайн «${d.label}» увімкнено для всіх (у вас самих — власний вибір із профілю)`
            : `Дизайн «${d.label}» увімкнено для всіх`);
        } catch (err) {
          toast(err.message);
        }
        renderDesignOptions();
      },
    },
    h('span', { class: `design-preview design-preview-${key}`, 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
    h('span', { class: 'design-name' }, d.label),
    h('span', { class: 'sub' }, d.note))));
  renderDesignOptions();

  mount(
    h('p', {}, h('a', { href: '#/' }, '← Усі групи')),
    h('h1', {}, 'Адмінка'),
    brandingCard,
    h('div', { class: 'card' },
      h('h2', {}, 'Дизайн'),
      h('p', { class: 'sub' }, 'Загальний дизайн для всіх. Кожен користувач може вибрати власний у «Профілі» — тоді в нього буде його вибір.'),
      designOptions,
    ),
    h('div', { class: 'card' },
      h('h2', {}, 'Валюта за замовчуванням'),
      h('p', { class: 'sub' }, 'Її першою пропонує форма «Нова група». Уже створені групи не змінюються.'),
      currencyForm,
    ),
    h('div', { class: 'card' },
      h('h2', {}, `Теги витрат (${categories.length})`),
      h('p', { class: 'sub' }, 'Спільні для всіх груп. Порядок тут — такий самий у списку вибору тегу. Натисніть на значок, щоб змінити його.'),
      h('ul', { class: 'list tags' }, categories.map(tagRow)),
      h('h3', {}, 'Новий тег'),
      addForm,
    ),
    h('div', { class: 'card' },
      h('h2', {}, `Користувачі (${users.length})`),
      h('ul', { class: 'list' }, users.map(userRow)),
    ),
  );
}

/** Адмінка: логотип (2:1), назва й опис сайту, картинка-прев'ю для соцмереж. */
function brandingSettingsCard(meta) {
  const state = {
    og: { path: meta?.og_image_path ?? null, file: null },
  };
  const previews = new Map();
  const urlOf = (item, fallback) => {
    if (item.file) {
      if (!previews.has(item.file)) previews.set(item.file, URL.createObjectURL(item.file));
      return previews.get(item.file);
    }
    return item.path ? brandingUrl(item.path) : fallback;
  };

  const titleInput = h('input', { name: 'title', value: meta?.site_title ?? '', maxLength: 120, required: true });
  const descInput = h('textarea', { name: 'description', maxLength: 300, rows: 3, required: true });
  descInput.value = meta?.site_description ?? '';
  const logoBox = h('div', { class: 'logo-preview' });
  const socialCard = h('div', { class: 'social-card' });
  const error = h('div', { class: 'error' });

  const pickImage = (onFile) => {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
    input.addEventListener('change', () => {
      const file = input.files[0];
      input.remove();
      if (file) onFile(file);
    });
    document.body.append(input);
    input.click();
  };

  // Логотип для кожного дизайну окремо: зберігається одразу після вибору файлу.
  const setDesignLogo = async (design, file, button) => {
    button.disabled = true;
    try {
      let path = null;
      if (file) {
        path = `logo-${design}-${Date.now()}.png`;
        await run(supabase.storage.from('branding').upload(path, await framedImage(file, 800, 400, 'contain'), { contentType: 'image/png' }));
      }
      const old = await run(supabase.rpc('admin_set_design_logo', { design, logo_path: path }));
      if (old) await supabase.storage.from('branding').remove([old]);
      await loadSiteMeta();
      toast(file ? `Логотип для дизайну «${DESIGNS[design].label}» збережено` : 'Логотип прибрано');
    } catch (err) {
      toast(err.message);
    }
    renderLogos();
  };

  function renderLogos() {
    logoBox.replaceChildren(...Object.entries(DESIGNS).map(([design, d]) => {
      const path = siteLogos?.[design] ?? null;
      const current = document.documentElement.dataset.design === design;
      return h('div', { class: 'logo-slot' },
        h('div', { class: 'logo-slot-head' },
          h('span', { class: 'design-name' }, d.label),
          current ? h('span', { class: 'badge' }, 'зараз увімкнено') : null),
        h('div', { class: `logo-frame logo-frame-${design}` },
          path ? h('img', { src: brandingUrl(path), alt: `Логотип для дизайну «${d.label}»` }) : h('span', {}, '💸 Спільні витрати')),
        h('div', { class: 'btn-row' },
          h('button', {
            type: 'button', class: 'secondary',
            onClick: (e) => {
              const button = e.currentTarget;
              pickImage((file) => setDesignLogo(design, file, button));
            },
          }, path ? '🖼 Замінити' : '🖼 Завантажити'),
          path && h('button', {
            type: 'button', class: 'secondary',
            onClick: (e) => {
              if (confirm(`Прибрати логотип для дизайну «${d.label}»?`)) setDesignLogo(design, null, e.currentTarget);
            },
          }, '✕ Прибрати'),
        ));
    }));
  }

  function render() {
    const ogUrl = urlOf(state.og, '/og.png');
    socialCard.replaceChildren(
      h('img', { src: ogUrl, alt: '' }),
      h('div', { class: 'social-text' },
        h('div', { class: 'social-host' }, location.host),
        h('div', { class: 'social-title' }, titleInput.value || '—'),
        h('div', { class: 'social-desc' }, descInput.value || '—'),
      ),
    );
  }
  titleInput.addEventListener('input', render);
  descInput.addEventListener('input', render);

  const form = h('form', {},
    h('h3', {}, 'Прев\'ю для соцмереж і пошуку'),
    h('p', { class: 'sub' }, 'Так виглядатиме посилання на сайт у Telegram, Viber, Facebook. Оновлюється в прев\'ю протягом кількох хвилин (месенджери можуть ще й кешувати старе).'),
    h('label', {}, 'Назва сайту (до 120 символів)', titleInput),
    h('label', {}, 'Опис (до 300 символів)', descInput),
    socialCard,
    h('div', { class: 'btn-row' },
      h('button', {
        type: 'button', class: 'secondary',
        onClick: () => pickImage(async (file) => {
          try {
            state.og.file = await framedImage(file, 1200, 630, 'cover');
            render();
          } catch (err) { toast(err.message); }
        }),
      }, '🖼 Своя картинка-прев\'ю (1200×630)'),
      h('button', {
        type: 'button', class: 'secondary',
        onClick: () => { state.og = { path: null, file: null }; render(); },
      }, 'Типова картинка'),
    ),
    error,
    h('button', { type: 'submit' }, 'Зберегти брендинг'),
  );

  const upload = async (item, prefix) => {
    if (!item.file) return item.path;
    const ext = item.file.type === 'image/png' ? 'png' : 'jpg';
    const path = `${prefix}-${Date.now()}.${ext}`;
    await run(supabase.storage.from('branding').upload(path, item.file, { contentType: item.file.type }));
    return path;
  };
  form.addEventListener('submit', submitHandler(form, error, async () => {
    const ogPath = await upload(state.og, 'og');
    const [old] = await run(supabase.rpc('admin_set_branding', {
      site_title: titleInput.value, site_description: descInput.value, logo_path: meta?.logo_path ?? null, og_image_path: ogPath,
    }));
    const stale = [old?.old_og_image_path].filter(Boolean);
    if (stale.length > 0) await supabase.storage.from('branding').remove(stale);
    state.og = { path: ogPath, file: null };
    await loadSiteMeta();
    render();
    toast('Брендинг збережено');
  }));
  render();
  renderLogos();

  return h('div', { class: 'card' },
    h('h2', {}, 'Брендинг і SEO'),
    h('h3', {}, 'Логотип для кожного дизайну'),
    h('p', { class: 'sub' }, 'Показується зліва вгорі замість назви. Для кожного дизайну — свій (наприклад, світлий логотип на темну шапку). '
      + 'Пропорція 2:1 (800×400) — інші картинки впишемо в цю рамку. Найкраще — PNG з прозорим тлом. Зберігається одразу.'),
    logoBox,
    form);
}

// ---------- Вхід / реєстрація ----------

/** Запит листа для відновлення пароля. */
function renderForgotPassword(email = '') {
  const error = h('div', { class: 'error' });
  const form = h('form', {},
    h('label', {}, 'Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email', value: email })),
    error,
    h('button', { type: 'submit' }, 'Надіслати посилання'),
  );
  form.addEventListener('submit', submitHandler(form, error, async (data) => {
    const address = String(data.get('email')).trim();
    await run(supabase.auth.resetPasswordForEmail(address, { redirectTo: `${location.origin}${location.pathname}` }));
    mount(
      h('div', { class: 'card auth' },
        h('h1', {}, 'Перевірте пошту'),
        h('p', {}, `Якщо акаунт з адресою ${address} існує, ми надіслали на неї лист. Перейдіть за посиланням у ньому, щоб створити новий пароль.`),
        h('a', { href: '#/login', onClick: () => renderAuth() }, '← До входу'),
      ),
    );
  }));
  mount(
    h('div', { class: 'card auth' },
      h('h1', {}, 'Відновлення пароля'),
      h('p', { class: 'sub' }, 'Вкажіть email, з яким ви реєструвалися, — надішлемо посилання для створення нового пароля.'),
      form,
      h('a', { href: '#/login', onClick: () => renderAuth() }, '← До входу'),
    ),
  );
}

/** Новий пароль після переходу за посиланням з листа (людина вже увійшла через це посилання). */
function renderResetPassword() {
  const error = h('div', { class: 'error' });
  const form = h('form', {},
    h('label', {}, 'Новий пароль', h('input', { name: 'password', type: 'password', required: true, minLength: 8, autocomplete: 'new-password' })),
    h('label', {}, 'Повторіть пароль', h('input', { name: 'confirm', type: 'password', required: true, minLength: 8, autocomplete: 'new-password' })),
    error,
    h('button', { type: 'submit' }, 'Зберегти пароль'),
  );
  form.addEventListener('submit', submitHandler(form, error, async (data) => {
    const password = String(data.get('password'));
    if (password !== String(data.get('confirm'))) throw new Error('Паролі не збігаються');
    await run(supabase.auth.updateUser({ password }));
    passwordRecovery = false;
    toast('Пароль змінено');
    location.hash = '#/';
  }));
  mount(
    h('div', { class: 'card auth' },
      h('h1', {}, 'Новий пароль'),
      h('p', { class: 'sub' }, 'Придумайте новий пароль — щонайменше 8 символів.'),
      form,
    ),
  );
}

/** Кольоровий логотип Google (статичний SVG). */
function googleIcon() {
  const span = h('span', { class: 'google-icon', 'aria-hidden': 'true' });
  span.innerHTML = '<svg viewBox="0 0 48 48" width="18" height="18">'
    + '<path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/>'
    + '<path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/>'
    + '<path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.8-6.1z"/>'
    + '<path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.2-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/>'
    + '</svg>';
  return span;
}

function renderAuth(invite = null) {
  let mode = invite ? 'register' : 'login';
  const error = h('div', { class: 'error' });
  const nameField = h('label', {}, "Ім'я", h('input', { name: 'name', autocomplete: 'name' }));
  const submit = h('button', { type: 'submit' });
  const form = h('form', {},
    nameField,
    h('label', {}, 'Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
    h('label', {}, 'Пароль', h('input', { name: 'password', type: 'password', required: true, minLength: 8 })),
    error,
    submit,
  );
  const forgot = h('a', {
    href: '#/login',
    class: 'forgot',
    onClick: (event) => {
      event.preventDefault();
      renderForgotPassword(String(form.querySelector('[name=email]').value).trim());
    },
  }, 'Забули пароль?');
  form.insertBefore(forgot, error);
  const tabLogin = h('button', { type: 'button', onClick: () => setMode('login') }, 'Вхід');
  const tabRegister = h('button', { type: 'button', onClick: () => setMode('register') }, 'Реєстрація');

  function setMode(next) {
    mode = next;
    nameField.hidden = mode === 'login';
    forgot.hidden = mode !== 'login';
    nameField.querySelector('input').required = mode === 'register';
    form.querySelector('[name=password]').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    submit.textContent = mode === 'login' ? 'Увійти' : 'Зареєструватися';
    tabLogin.className = mode === 'login' ? '' : 'secondary';
    tabRegister.className = mode === 'register' ? '' : 'secondary';
    error.textContent = '';
  }

  form.addEventListener('submit', submitHandler(form, error, async (data) => {
    const email = String(data.get('email')).trim();
    const password = String(data.get('password'));
    if (mode === 'login') {
      await run(supabase.auth.signInWithPassword({ email, password }));
    } else {
      const result = await run(supabase.auth.signUp({
        email,
        password,
        options: { data: { name: String(data.get('name')).trim() }, emailRedirectTo: location.origin },
      }));
      if (!result.session) {
        mount(
          h('div', { class: 'card auth' },
            h('h1', {}, 'Перевірте пошту'),
            h('p', {}, `Ми надіслали лист на ${email}. Перейдіть за посиланням у ньому, щоб підтвердити реєстрацію, а потім увійдіть.`),
            h('a', { href: '#/login', onClick: () => renderAuth(invite) }, '← До входу'),
          ),
        );
        return;
      }
    }
    currentUser = await loadCurrentUser();
    renderUserbox();
    const token = pendingInvite.get();
    const target = token ? `#/join/${token}` : '#/';
    if (location.hash === target) route();
    else location.hash = target;
  }));

  const googleError = h('div', { class: 'error' });
  const googleButton = h('button', {
    type: 'button',
    class: 'secondary google-btn',
    onClick: async () => {
      googleError.textContent = '';
      googleButton.disabled = true;
      try {
        // Після входу Google поверне користувача на сайт; запрошення (якщо було) лишається в localStorage.
        await run(supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin } }));
      } catch (err) {
        googleError.textContent = err.message;
        googleButton.disabled = false;
      }
    },
  }, googleIcon(), 'Продовжити з Google');

  setMode(mode);
  mount(
    h('div', { class: 'card auth' },
      h('h1', {}, 'Ласкаво просимо'),
      invite
        ? h('p', { class: 'invite-banner' },
          'Вас запрошено до групи ', h('strong', {}, `«${invite.name}»`),
          '. Зареєструйтесь або увійдіть — і ви одразу потрапите в групу.')
        : h('p', { class: 'sub' }, 'Ведіть спільні витрати з друзями, сусідами чи колегами та дізнавайтеся, хто кому скільки винен.'),
      googleButton,
      googleError,
      h('div', { class: 'divider' }, 'або через email'),
      h('div', { class: 'tabs' }, tabLogin, tabRegister),
      form,
    ),
  );
}

// ---------- Список груп ----------

/** Баланс групи міткою: «вам винні …» зелена, «ви винні …» червона, «розраховано» сіра. */
function balancePill(balance, currency) {
  if (balance > 0) return h('span', { class: 'balance-pill pos' }, `вам винні ${formatMoney(balance, currency)}`);
  if (balance < 0) return h('span', { class: 'balance-pill neg' }, `ви винні ${formatMoney(-balance, currency)}`);
  return h('span', { class: 'balance-pill' }, '✓ розраховано');
}

function balanceLabel(balance, currency = baseCurrency) {
  if (balance > 0) return h('span', { class: 'amount pos' }, `вам винні ${formatMoney(balance, currency)}`);
  if (balance < 0) return h('span', { class: 'amount neg' }, `ви винні ${formatMoney(-balance, currency)}`);
  return h('span', { class: 'amount sub' }, 'розраховано');
}

/** Кілька маленьких аватарів, що накладаються один на одного. */
function avatarStack(profiles, max = 5) {
  const extra = profiles.length - max;
  return h('span', { class: 'avatar-stack' },
    profiles.slice(0, max).map((p) => avatar(p, 'xs')),
    extra > 0 && h('span', { class: 'avatar avatar-xs more' }, `+${extra}`),
  );
}

const formatCreated = (ts) => new Date(ts).toLocaleDateString('uk-UA');

async function setGroupArchived(groupId, archived) {
  await run(supabase.rpc('set_group_archived', { gid: groupId, archived }));
  toast(archived ? 'Групу перенесено в архів' : 'Групу повернуто з архіву');
}

/** Список груп: активні (showArchive = false) або архівні. */
/**
 * Панель пошуку й фільтрів: рядок пошуку завжди видно, решта — під кнопкою «Фільтри».
 * state — об'єкт фільтра (змінюється на місці), onChange() — перемалювати результати.
 * extras(state, onChange) — додаткові поля (списки, перемикачі) для розгорнутої частини.
 */
function filterBar(state, onChange, { placeholder, extras = () => [] } = {}) {
  const search = h('input', {
    type: 'search', class: 'filter-search', value: state.query ?? '', placeholder, 'aria-label': placeholder,
    enterKeyHint: 'search',
  });
  search.addEventListener('input', () => { state.query = search.value; changed(); });
  const panel = h('div', { class: 'filter-panel', hidden: !state.open });
  const count = h('span', { class: 'filter-count' });
  const toggle = h('button', {
    type: 'button', class: 'secondary filter-toggle', 'aria-expanded': String(Boolean(state.open)),
    onClick: () => {
      state.open = !state.open;
      panel.hidden = !state.open;
      toggle.setAttribute('aria-expanded', String(state.open));
      toggle.classList.toggle('open', state.open);
    },
  }, 'Фільтри', count);
  const reset = h('button', {
    type: 'button', class: 'link filter-reset',
    onClick: () => {
      Object.assign(state, { query: '', period: 'all', from: '', to: '', balance: 'all', categoryId: '', payerId: '', onlyMine: false });
      search.value = '';
      renderPanel();
      changed();
    },
  }, 'Скинути');

  function activeCount() {
    return [state.period && state.period !== 'all', state.balance && state.balance !== 'all',
      state.categoryId, state.payerId, state.onlyMine].filter(Boolean).length;
  }
  function changed() {
    const n = activeCount();
    count.textContent = n ? String(n) : '';
    toggle.classList.toggle('has-active', n > 0);
    reset.hidden = !isFiltered(state);
    onChange();
  }
  function renderPanel() {
    const periods = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Період' },
      Object.entries(FILTER_PERIODS).map(([value, label]) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String((state.period ?? 'all') === value),
        class: (state.period ?? 'all') === value ? 'active' : '',
        onClick: () => { state.period = value; renderPanel(); changed(); },
      }, label)));
    const dateInput = (key, label) => {
      const input = h('input', { type: 'date', value: state[key] ?? '', 'aria-label': label });
      input.addEventListener('change', () => { state[key] = input.value; changed(); });
      return h('label', {}, label, input);
    };
    panel.replaceChildren(...[
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Дата'), periods),
      state.period === 'custom' ? h('div', { class: 'row filter-dates' }, dateInput('from', 'Від'), dateInput('to', 'До')) : null,
      ...extras(state, () => { renderPanel(); changed(); }),
    ].filter(Boolean));
  }
  renderPanel();
  changed();
  return h('div', { class: 'filter-bar' },
    h('div', { class: 'filter-row' }, h('div', { class: 'filter-search-wrap' }, search), toggle),
    panel,
    reset);
}

/** Випадний список для панелі фільтрів. */
function filterSelect(label, value, options, onPick) {
  const select = h('select', { 'aria-label': label },
    options.map(([v, text]) => h('option', { value: v, selected: String(v) === String(value ?? '') }, text)));
  select.addEventListener('change', () => onPick(select.value));
  return h('label', {}, label, select);
}

// Фільтри списку груп — живуть між перемальовуваннями сторінки.
const groupsFilter = { query: '', period: 'all', from: '', to: '', balance: 'all', open: false };

async function renderGroups(showArchive = false) {
  const [groupRows, currencies, settings] = await Promise.all([
    run(supabase.rpc('group_list')),
    loadCurrencies(),
    run(supabase.from('app_settings').select('default_currency').maybeSingle()).catch(() => null),
  ]);
  const defaultCurrency = settings?.default_currency ?? 'UAH';
  const allGroups = groupRows.map((g) => ({
    id: g.id,
    name: g.name,
    currency: g.currency,
    memberCount: Number(g.member_count),
    myBalance: Number(g.my_balance),
    createdAt: g.created_at,
    archived: g.archived,
  }));
  const groups = allGroups.filter((g) => g.archived === showArchive);
  const archivedCount = allGroups.filter((g) => g.archived).length;
  // Учасники всіх груп одним запитом — для мініатюр аватарів.
  const memberRows = groups.length === 0 ? [] : await run(supabase.from('group_members')
    .select('group_id, profiles (id, name, avatar_path)').in('group_id', groups.map((g) => g.id)).order('id'));
  const membersOf = (groupId) => memberRows.filter((r) => r.group_id === groupId && r.profiles).map((r) => r.profiles);

  // Плитка групи: натискається вся (посилання розтягнуто на всю плитку); баланс — міткою внизу праворуч.
  const groupItem = (g) =>
    h('li', { class: 'group-tile' },
      h('div', { class: 'group-top' },
        h('a', { class: 'group-name', href: `#/groups/${g.id}` }, g.name),
        h('span', { class: 'group-go', 'aria-hidden': 'true' }, '›'),
      ),
      h('div', { class: 'group-meta' },
        avatarStack(membersOf(g.id)),
        h('span', { class: 'sub' }, `${g.memberCount} учасн.`),
      ),
      h('div', { class: 'group-bottom' },
        h('span', { class: 'created' }, `створено ${formatCreated(g.createdAt)}`),
        showArchive ? null : balancePill(g.myBalance, g.currency),
      ),
      showArchive
        ? h('button', {
          class: 'secondary',
          onClick: async (e) => {
            e.target.disabled = true;
            try {
              await setGroupArchived(g.id, false);
              renderGroups(true);
            } catch (err) {
              toast(err.message);
              e.target.disabled = false;
            }
          },
        }, 'Повернути')
        : null,
    );

  // Пошук і фільтри по групах (коли груп більше однієї).
  function groupsResults() {
    const list = h('ul', { class: 'list group-tiles' });
    const empty = h('div', { class: 'filter-empty', hidden: true });
    const render = () => {
      const shown = filterGroups(groups, groupsFilter, today());
      list.replaceChildren(...shown.map(groupItem));
      list.hidden = shown.length === 0;
      empty.hidden = shown.length > 0;
      empty.textContent = 'Нічого не знайдено — змініть пошук чи фільтри.';
    };
    const bar = groups.length > 1 && filterBar(groupsFilter, render, {
      placeholder: 'Пошук групи за назвою',
      extras: (state, update) => [
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Баланс'),
          h('div', { class: 'segmented' }, Object.entries(GROUP_BALANCE_FILTERS).map(([value, label]) => h('button', {
            type: 'button', class: (state.balance ?? 'all') === value ? 'active' : '',
            onClick: () => { state.balance = value; update(); },
          }, label)))),
      ],
    });
    render();
    return h('div', { class: 'group-results' }, bar, list, empty);
  }

  if (showArchive) {
    mount(
      h('h1', {}, 'Архів'),
      h('div', { class: 'card' },
        groups.length === 0
          ? h('p', { class: 'empty' }, 'В архіві порожньо. Групу, де всі розрахувалися, можна перенести сюди кнопкою «В архів» на її сторінці.')
          : groupsResults(),
      ),
      groups.length > 0 && h('p', { class: 'sub hint' },
        'Архів бачите лише ви — в інших учасників група лишається як була. Якщо в групі знову з\'являться борги, вона сама повернеться до активних.'),
    );
    return;
  }

  const error = h('div', { class: 'error' });
  const form = h('form', {},
    h('div', { class: 'create-group' },
      h('input', { name: 'name', placeholder: 'Напр. «Квартира» або «Відпустка 2026»', required: true, maxLength: 100 }),
      h('select', { name: 'currency', 'aria-label': 'Основна валюта групи', title: 'Основна валюта групи' },
        currencies.map((c) => h('option', { value: c.code, selected: c.code === defaultCurrency }, `${c.flag} ${c.code}`))),
      h('button', { type: 'submit' }, 'Створити групу'),
    ),
    h('p', { class: 'sub' }, 'Валюта — основна для групи: у ній рахуються баланси. Витрати можна вносити й в інших валютах за курсом.'),
    error,
  );
  form.addEventListener('submit', submitHandler(form, error, async (data) => {
    const groupId = await run(supabase.rpc('create_group', { group_name: data.get('name'), group_currency: data.get('currency') }));
    location.hash = `#/groups/${groupId}`;
  }));

  // Загальний баланс — окремо для кожної валюти (різні валюти не додаємо).
  const totals = new Map();
  for (const g of groups) totals.set(g.currency, (totals.get(g.currency) ?? 0) + g.myBalance);
  const totalLines = [...totals].filter(([, sum]) => sum !== 0);

  mount(
    h('h1', {}, 'Мої групи'),
    groups.length > 0 && h('div', { class: 'card hero' },
      h('div', { class: 'hero-label' }, 'Загальний баланс'),
      totalLines.length === 0
        ? h('div', { class: 'hero-amount' }, 'усе розраховано ✓')
        : totalLines.map(([currency, sum]) => h('div', { class: `hero-amount ${sum > 0 ? 'pos' : 'neg'}` },
          h('span', { class: 'hero-sign' }, sum > 0 ? 'вам винні' : 'ви винні'),
          bigMoney(Math.abs(sum), currency))),
    ),
    h('div', { class: 'card' },
      groups.length === 0
        ? h('p', { class: 'empty' }, archivedCount > 0 ? 'Активних груп немає. Створіть нову нижче.' : 'У вас ще немає груп. Створіть першу нижче.')
        : groupsResults(),
    ),
    h('div', { class: 'card' }, h('h2', {}, 'Нова група'), form),
  );
}

// ---------- Сторінка групи ----------

async function renderGroup(groupId) {
  const [group, memberRows, expenseRows, settlementRows, categories, history, rateRows] = await Promise.all([
    run(supabase.from('groups').select('id, name, currency, invite_token, created_by').eq('id', groupId).maybeSingle()),
    run(supabase.from('group_members').select('user_id, archived_at, profiles (id, name, email, avatar_path)').eq('group_id', groupId).order('id')),
    run(supabase.from('expenses')
      .select('id, description, amount, paid_by, date, category_id, receipt_path, receipt_path2, currency, original_amount, rate, expense_shares (user_id, amount)')
      .eq('group_id', groupId)
      .order('date', { ascending: false })
      .order('id', { ascending: false })),
    run(supabase.from('settlements')
      .select('id, from_user, to_user, amount, date')
      .eq('group_id', groupId)
      .order('date', { ascending: false })
      .order('id', { ascending: false })),
    run(supabase.from('categories').select('id, name, icon').order('sort_order').order('id')),
    run(supabase.from('expense_history')
      .select('id, expense_id, action, changed_by, changed_at, old_data, new_data')
      .eq('group_id', groupId)
      .order('id', { ascending: false })
      .limit(200)),
    run(supabase.from('group_rates').select('currency, rate, updated_at').eq('group_id', groupId)),
    loadCurrencies(),
  ]);
  if (!group) throw new Error('Групу не знайдено');
  baseCurrency = group.currency;
  const rates = new Map(rateRows.map((r) => [r.currency, Number(r.rate)]));

  const members = memberRows.map((r) => r.profiles);
  // Квитанції лежать у приватному сховищі — даємо тимчасові посилання на годину.
  const receiptPaths = expenseRows.flatMap((e) => [e.receipt_path, e.receipt_path2]).filter(Boolean);
  const receiptUrls = new Map();
  if (receiptPaths.length > 0) {
    const { data } = await supabase.storage.from('receipts').createSignedUrls(receiptPaths, 3600);
    for (const item of data ?? []) if (item.signedUrl) receiptUrls.set(item.path, item.signedUrl);
  }
  const expenses = expenseRows.map((e) => ({
    id: e.id,
    description: e.description,
    amount: Number(e.amount),
    paidBy: e.paid_by,
    date: e.date,
    categoryId: e.category_id,
    category: categories.find((c) => c.id === e.category_id) ?? null,
    // Фото витрати: [фото 1, фото 2] (null — порожній слот).
    photoPaths: [e.receipt_path, e.receipt_path2],
    photoUrls: [e.receipt_path, e.receipt_path2].map((path) => (path ? receiptUrls.get(path) ?? null : null)),
    edited: history.some((x) => x.action === 'updated' && x.expense_id === e.id),
    shares: e.expense_shares.map((s) => ({ userId: s.user_id, amount: Number(s.amount) })),
    currency: e.currency,
    originalAmount: e.original_amount === null ? null : Number(e.original_amount),
    rate: e.rate === null ? null : Number(e.rate),
  }));
  const settlements = settlementRows.map((s) => ({
    id: s.id, fromUser: s.from_user, toUser: s.to_user, amount: Number(s.amount), date: s.date,
  }));
  const balanceMap = computeBalances(members.map((m) => m.id), expenses, settlements);
  const balances = [...balanceMap].map(([userId, balance]) => ({ userId, balance }));
  const suggestedTransfers = simplifyDebts(balanceMap);
  const nameOf = (id) => members.find((m) => m.id === id)?.name ?? '—';
  const profileOf = (id) => members.find((m) => m.id === id) ?? { name: '—' };
  const reload = () => renderGroup(groupId);
  const categoryOf = (id) => categories.find((c) => c.id === id) ?? null;

  // Форма витрати: «нова» або редагування вибраної витрати.
  const formSlot = h('div', {});
  const showExpenseForm = (editing = null) => {
    formSlot.replaceChildren(expenseFormCard(groupId, members, categories, rates, reload, editing, () => showExpenseForm()));
    if (editing) {
      formSlot.scrollIntoView({ behavior: 'smooth', block: 'start' });
      formSlot.querySelector('input[name=description]').focus({ preventScroll: true });
    }
  };
  showExpenseForm();

  // Меню «☰» біля назви групи відкриває додаткові блоки; відкритий блок лишається відкритим після оновлення.
  const panels = h('div', {});
  const panelDefs = {
    transfers: {
      label: '🤝 Хто кому винен',
      count: suggestedTransfers.length,
      render: () => transfersCard(groupId, suggestedTransfers, nameOf, reload),
    },
    settle: { label: '💸 Повернення боргу', render: () => settlementFormCard(groupId, members, reload) },
    members: { label: '👥 Учасники', count: members.length, muted: true, render: () => membersCard(group, members, reload) },
    rates: { label: '💱 Курси валют', count: rates.size, muted: true, render: () => ratesCard(group, rateRows, reload) },
    analytics: { label: '📊 Аналітика', render: () => analyticsCard(expenses, members, categoryOf) },
    history: { label: '🕘 Історія змін', render: () => historyCard(history, nameOf, categoryOf) },
    report: { label: '📄 Звіт (Excel, PDF)', render: () => reportCard(group, members, expenses, settlements, categoryOf) },
    // Порожню групу (без витрат і повернень) автор може видалити.
    ...(group.created_by === currentUser.id && expenses.length === 0 && settlements.length === 0 ? {
      delete: {
        label: '🗑 Видалити групу',
        danger: true,
        action: async () => {
          if (!confirm(`Видалити групу «${group.name}»? Витрат у ній немає; учасників буде прибрано з групи. Цю дію не можна скасувати.`)) return;
          try {
            await run(supabase.rpc('delete_group', { gid: groupId }));
            toast('Групу видалено');
            location.hash = '#/';
          } catch (err) {
            toast(err.message);
          }
        },
      },
    } : {}),
  };
  const menu = groupMenu(panelDefs, (key) => {
    groupUi.panel = groupUi.panel === key ? null : key;
    renderPanels();
    if (groupUi.panel) panels.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  const renderPanels = () => {
    menu.update(groupUi.panel);
    const def = panelDefs[groupUi.panel];
    panels.replaceChildren(...(def ? [h('div', { class: 'panel' },
      def.render(),
      h('button', {
        type: 'button', class: 'link panel-close', title: 'Закрити', 'aria-label': 'Закрити',
        onClick: () => { groupUi.panel = null; renderPanels(); },
      }, '✕'),
    )] : []));
  };
  if (groupUi.groupId !== groupId) Object.assign(groupUi, { groupId, panel: null, period: 'all', inviteOpen: false, openExpenses: new Set(), expenseFilter: newExpenseFilter() });
  renderPanels();

  // Архів: коли всі розрахувалися, групу можна сховати (лише для себе).
  const settled = balances.every((b) => b.balance === 0);
  const archived = settled && Boolean(memberRows.find((r) => r.user_id === currentUser.id)?.archived_at);
  const archiveButton = (toArchive) => h('button', {
    class: 'secondary',
    onClick: async (e) => {
      e.target.disabled = true;
      try {
        await setGroupArchived(groupId, toArchive);
        reload();
      } catch (err) {
        toast(err.message);
        e.target.disabled = false;
      }
    },
  }, toArchive ? 'В архів' : 'Повернути з архіву');
  const archiveBar = archived
    ? h('div', { class: 'archive-bar' }, h('span', {}, '🗄 Група в архіві'), archiveButton(false))
    : settled && (expenses.length > 0 || settlements.length > 0)
      ? h('div', { class: 'archive-bar' }, h('span', {}, 'Усі розрахувалися 🎉'), archiveButton(true))
      : null;

  mount(
    h('p', {}, archived ? h('a', { href: '#/archive' }, '← Архів') : h('a', { href: '#/' }, '← Усі групи')),
    h('div', { class: 'group-head' }, groupTitle(group, reload), menu.el),
    archiveBar,
    panels,
    h('div', { class: 'grid' },
      balancesCard(balances, profileOf),
      h('div', {}, formSlot),
    ),
    expensesCard(groupId, expenses, profileOf, reload, showExpenseForm),
    settlementsCard(groupId, settlements, nameOf, reload),
  );
}

// ---------- Звіт по групі (Excel / Google Таблиці) ----------

const EXCELJS_URL = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
let excelLoading = null;

/** Бібліотека для .xlsx (~1 МБ) — завантажується лише тоді, коли звіт вперше потрібен. */
function loadExcelJS() {
  excelLoading ??= new Promise((resolve, reject) => {
    const script = h('script', { src: EXCELJS_URL });
    script.onload = () => resolve(window.ExcelJS);
    script.onerror = () => {
      excelLoading = null;
      reject(new Error('Не вдалося завантажити модуль Excel. Перевірте інтернет.'));
    };
    document.head.append(script);
  });
  return excelLoading;
}

const PDFMAKE_URLS = [
  'https://cdn.jsdelivr.net/npm/pdfmake@0.2.20/build/pdfmake.min.js',
  'https://cdn.jsdelivr.net/npm/pdfmake@0.2.20/build/vfs_fonts.js', // шрифт Roboto з кирилицею
];
let pdfLoading = null;

/** pdfmake (~2 МБ разом зі шрифтом) — лише тоді, коли PDF вперше потрібен. */
function loadPdfMake() {
  const loadScript = (src) => new Promise((resolve, reject) => {
    const script = h('script', { src });
    script.onload = resolve;
    script.onerror = () => reject(new Error('Не вдалося завантажити модуль PDF. Перевірте інтернет.'));
    document.head.append(script);
  });
  pdfLoading ??= loadScript(PDFMAKE_URLS[0]).then(() => loadScript(PDFMAKE_URLS[1])).then(() => window.pdfMake)
    .catch((err) => {
      pdfLoading = null;
      throw err;
    });
  return pdfLoading;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Значки форматів (статичні SVG-рядки).
const FILE_ICONS = {
  xlsx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M4 9h16M4 15h16M10 9v12"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
};

function reportCard(group, members, expenses, settlements, categoryOf) {
  // Період — перемикачі-пігулки замість списку.
  let period = 'all';
  const periodChips = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Період звіту' });
  const renderPeriods = () => periodChips.replaceChildren(...Object.entries(REPORT_PERIODS).map(([value, label]) =>
    h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(value === period),
      class: value === period ? 'active' : '',
      onClick: () => { period = value; renderPeriods(); },
    }, label)));
  renderPeriods();

  const status = h('p', { class: 'sub report-status', role: 'status' });
  const safeName = group.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'група';
  const makeReport = () => {
    const now = new Date();
    return buildReport({
      group, members, settlements, categoryOf,
      expenses: expenses.map((e) => ({ ...e, photoCount: e.photoPaths.filter(Boolean).length })),
      period,
      todayIso: today(),
      generatedAt: new Date(now.getTime() - now.getTimezoneOffset() * 60000), // місцевий час у звіті
      currencyName: currencyInfo(group.currency).name,
    });
  };
  const exportTile = (kind, title, note, action) => {
    const icon = h('span', { class: `file-icon ${kind}`, 'aria-hidden': 'true' });
    icon.innerHTML = FILE_ICONS[kind];
    const tile = h('button', {
      type: 'button', class: 'export-tile',
      onClick: async () => {
        tile.disabled = true;
        tile.classList.add('busy');
        status.textContent = `Готую ${title}…`;
        try {
          await action();
          status.textContent = `✓ ${title} завантажено`;
        } catch (err) {
          status.textContent = err.message;
        } finally {
          tile.disabled = false;
          tile.classList.remove('busy');
        }
      },
    },
    icon,
    h('span', { class: 'export-text' }, h('span', { class: 'export-title' }, title), h('span', { class: 'export-note' }, note)),
    h('span', { class: 'export-arrow', 'aria-hidden': 'true' }, '↓'));
    return tile;
  };
  const excelTile = exportTile('xlsx', 'Excel', 'Таблиця · 4 аркуші', async () => {
    const ExcelJS = await loadExcelJS();
    const buffer = await writeWorkbook(ExcelJS, makeReport()).xlsx.writeBuffer();
    saveBlob(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `Звіт — ${safeName} — ${today()}.xlsx`);
  });
  const pdfTile = exportTile('pdf', 'PDF', 'Документ A4 для друку', async () => {
    const pdfMake = await loadPdfMake();
    const blob = await new Promise((resolve) => pdfMake.createPdf(buildPdfDoc(makeReport())).getBlob(resolve));
    saveBlob(blob, `Звіт — ${safeName} — ${today()}.pdf`);
  });

  return h('div', { class: 'card report-card' },
    h('h2', {}, 'Звіт по групі'),
    h('p', { class: 'sub' }, 'Усі оплати, частки учасників, баланси й хто кому винен.'),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Період'), periodChips),
    h('div', { class: 'export-tiles' }, excelTile, pdfTile),
    status,
    h('details', { class: 'report-help' },
      h('summary', {}, 'Що всередині та як відкрити в Google Таблицях'),
      h('p', { class: 'sub' }, 'Excel: «Підсумок», «Витрати» (дата, опис, тег, хто платив, сума, валюта й курс, частка кожного), '
        + '«Повернення боргів», «По тегах». PDF — те саме на аркушах A4.'),
      h('p', { class: 'sub' }, 'Google Таблиці: sheets.new → «Файл» → «Імпортувати» → «Завантажити» й виберіть файл Excel.')),
  );
}

// Стан сторінки групи, що переживає перемальовування (відкрита панель, період аналітики, блок запрошення).
const newExpenseFilter = () => ({ query: '', period: 'all', from: '', to: '', categoryId: '', payerId: '', onlyMine: false, open: false });
const groupUi = { groupId: null, panel: null, period: 'all', inviteOpen: false, openExpenses: new Set(), expenseFilter: newExpenseFilter() };

/** Кнопка «☰» з випадаючим списком блоків групи. onPick(key) відкриває/закриває блок. */
function groupMenu(defs, onPick) {
  const list = h('div', { class: 'menu-list', role: 'menu', hidden: true });
  const button = h('button', {
    type: 'button', class: 'menu-button', title: 'Меню групи', 'aria-label': 'Меню групи',
    'aria-haspopup': 'true', 'aria-expanded': 'false',
    onClick: (e) => {
      e.stopPropagation();
      setOpen(list.hidden);
    },
  });
  button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  const el = h('div', { class: 'menu' }, button, list);

  const close = (e) => {
    if (e.type === 'keydown' && e.key !== 'Escape') return;
    if (e.type === 'click' && el.contains(e.target)) return;
    setOpen(false);
  };
  function setOpen(open) {
    list.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.classList.toggle('open', open);
    // Закривається кліком поза меню або клавішею Esc.
    const method = open ? 'addEventListener' : 'removeEventListener';
    document[method]('click', close);
    document[method]('keydown', close);
  }

  return {
    el,
    update(active) {
      list.replaceChildren(...Object.entries(defs).map(([key, def]) =>
        h('button', {
          type: 'button', role: 'menuitem',
          class: ['menu-item', key === active ? 'active' : '', def.danger ? 'danger' : ''].filter(Boolean).join(' '),
          onClick: () => {
            setOpen(false);
            if (def.action) def.action(); // пункт-дія (напр. «Видалити групу»), а не блок
            else onPick(key);
          },
        },
        h('span', {}, def.label),
        def.count ? h('span', { class: def.muted ? 'menu-count muted' : 'menu-count' }, String(def.count)) : null,
        key === active ? h('span', { class: 'menu-check' }, '✓') : null)));
      button.classList.toggle('has-active', Boolean(active));
    },
  };
}

// ---------- Аналітика ----------

const PERIODS = { all: 'Весь час', month: 'Цей місяць', 'prev-month': 'Минулий місяць', year: 'Цей рік' };
const monthName = (ym) => {
  const text = new Date(`${ym}-01T00:00:00`).toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' });
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** Рядок з горизонтальною смужкою: підпис, смужка (частка від max), значення. */
function barRow(label, value, max, detail) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return h('li', { class: 'bar-row', title: `${typeof label === 'string' ? label : ''} ${formatMoney(value)}${detail ? ` · ${detail}` : ''}`.trim() },
    h('div', { class: 'bar-head' },
      h('span', { class: 'bar-label' }, label),
      h('span', { class: 'amount' }, formatMoney(value)),
    ),
    h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: `width:${pct}%` })),
    detail && h('div', { class: 'sub' }, detail),
  );
}

function analyticsCard(allExpenses, members, categoryOf) {
  const card = h('div', { class: 'card analytics' });
  const draw = () => {
    const expenses = filterByPeriod(allExpenses, groupUi.period, today());
    const s = summarize(expenses, members.map((m) => m.id));
    const profileOf = (id) => members.find((m) => m.id === id) ?? { name: '—' };
    const period = h('select', {
      'aria-label': 'Період',
      onChange: (e) => { groupUi.period = e.target.value; draw(); },
    }, Object.entries(PERIODS).map(([value, label]) => h('option', { value, selected: value === groupUi.period }, label)));

    const tile = (label, value, hint) => h('div', { class: 'stat' },
      h('div', { class: 'stat-label' }, label),
      h('div', { class: 'stat-value' }, value),
      hint && h('div', { class: 'sub' }, hint));

    const maxShare = Math.max(0, ...s.people.map((p) => p.share));
    const maxCat = Math.max(0, ...s.categories.map((c) => c.total));
    const maxMonth = Math.max(0, ...s.months.map((m) => m.total));
    const pctOf = (v) => (s.total ? `${Math.round((v / s.total) * 100)}%` : '0%');

    card.replaceChildren(
      h('div', { class: 'card-head' }, h('h2', {}, 'Аналітика'), period),
      s.count === 0
        ? h('p', { class: 'empty' }, 'За цей період витрат немає.')
        : h('div', {},
          h('div', { class: 'stats' },
            tile('Усього витрачено', formatMoney(s.total)),
            tile('Витрат', String(s.count)),
            tile('Середній чек', formatMoney(s.average), 'сума однієї витрати'),
            tile('На 1 учасника', formatMoney(s.perMember), `загальна сума ÷ ${members.length}`),
          ),
          h('h3', {}, 'Учасники'),
          h('p', { class: 'sub' }, 'Частка — скільки витрат припадає на людину; середній чек — її середня частка в одній витраті.'),
          h('ul', { class: 'bars' }, s.people.map((p) => barRow(
            h('span', { class: 'person' }, avatar(profileOf(p.userId)), profileOf(p.userId).name),
            p.share, maxShare,
            `${pctOf(p.share)} · заплатив(ла) ${formatMoney(p.paid)} · середній чек ${formatMoney(p.averageShare)} (${p.shareCount})`,
          ))),
          h('h3', {}, 'Теги'),
          h('ul', { class: 'bars' }, s.categories.map((c) => {
            const cat = categoryOf(c.categoryId);
            return barRow(cat ? categoryLabel(cat) : 'Без тегу', c.total, maxCat, `${pctOf(c.total)} · витрат: ${c.count}`);
          })),
          s.months.length > 1 && h('h3', {}, 'По місяцях'),
          s.months.length > 1 && h('ul', { class: 'bars' }, s.months.map((m) => barRow(monthName(m.month), m.total, maxMonth))),
        ),
    );
  };
  draw();
  return card;
}

// ---------- Історія змін ----------

function describeChange(entry, nameOf, categoryOf) {
  const o = entry.old_data ?? {};
  const n = entry.new_data ?? {};
  const money = (v) => formatMoney(Number(v));
  const tag = (id) => (id ? (categoryOf(id) ? categoryLabel(categoryOf(id)) : 'видалений тег') : 'без тегу');
  const sharesText = (shares = []) => shares.map((x) => `${nameOf(x.user_id)} ${money(x.amount)}`).join(', ') || '—';
  if (entry.action === 'created') return [`додав(ла) «${n.description}» — ${money(n.amount)}`];
  if (entry.action === 'deleted') return [`видалив(ла) «${o.description}» — ${money(o.amount)}`];
  const changes = [];
  if (o.description !== n.description) changes.push(`опис: «${o.description}» → «${n.description}»`);
  if (Number(o.amount) !== Number(n.amount)) changes.push(`сума: ${money(o.amount)} → ${money(n.amount)}`);
  if (o.paid_by !== n.paid_by) changes.push(`платив(ла): ${nameOf(o.paid_by)} → ${nameOf(n.paid_by)}`);
  if (o.date !== n.date) changes.push(`дата: ${formatDate(o.date)} → ${formatDate(n.date)}`);
  if ((o.category_id ?? null) !== (n.category_id ?? null)) changes.push(`тег: ${tag(o.category_id)} → ${tag(n.category_id)}`);
  if (JSON.stringify(o.shares) !== JSON.stringify(n.shares)) changes.push(`частки: ${sharesText(o.shares)} → ${sharesText(n.shares)}`);
  return [`змінив(ла) «${o.description}»`, ...changes];
}

function historyCard(history, nameOf, categoryOf) {
  const when = (ts) => new Date(ts).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const icons = { created: '➕', updated: '✎', deleted: '🗑' };
  return h('div', { class: 'card' },
    h('h2', {}, 'Історія змін'),
    history.length === 0
      ? h('p', { class: 'empty' }, 'Змін ще немає. Тут з\'являтимуться додавання, редагування та видалення витрат.')
      : h('ul', { class: 'list history' }, history.map((entry) => {
        const [headline, ...details] = describeChange(entry, nameOf, categoryOf);
        return h('li', {},
          h('div', {},
            h('div', {}, `${icons[entry.action]} `, h('strong', {}, nameOf(entry.changed_by)), ` ${headline}`),
            details.length > 0 && h('ul', { class: 'changes' }, details.map((d) => h('li', {}, d))),
            h('div', { class: 'sub' }, when(entry.changed_at)),
          ),
        );
      })),
  );
}

/** Назва групи; автор може її змінити (кнопка ✎). */
function groupTitle(group, reload) {
  const title = h('div', { class: 'title-row' }, h('h1', {}, group.name));
  if (group.created_by !== currentUser.id) return title;

  const error = h('div', { class: 'error' });
  const form = h('form', { class: 'rename' },
    h('div', { class: 'row' },
      h('input', { name: 'name', value: group.name, required: true, maxLength: 100, 'aria-label': 'Назва групи' }),
      h('div', { class: 'actions' },
        h('button', { type: 'submit' }, 'Зберегти'),
        h('button', { type: 'button', class: 'secondary', onClick: () => form.replaceWith(title) }, 'Скасувати'),
      ),
    ),
    error,
  );
  form.addEventListener('submit', submitHandler(form, error, async (data) => {
    const name = String(data.get('name')).trim();
    if (!name) throw new Error('Вкажіть назву');
    const updated = await run(supabase.from('groups').update({ name }).eq('id', group.id).select('id'));
    if (updated.length === 0) throw new Error('Змінити назву може лише автор групи');
    toast('Назву змінено');
    reload();
  }));

  title.append(h('button', {
    class: 'link',
    title: 'Змінити назву групи',
    onClick: () => {
      title.replaceWith(form);
      form.querySelector('input').focus();
    },
  }, '✎'));
  return title;
}

/** Ім'я учасника; своє — жирним. */
const memberName = (m) => (m.id === currentUser.id ? h('strong', {}, m.name) : m.name);

/** Ім'я з маленьким аватаром; поточного користувача позначено «ви». */
function personLabel(profile) {
  const isMe = profile?.id === currentUser.id;
  return h('span', { class: `person${isMe ? ' me-name-strong' : ''}` },
    avatar(profile, 'xs'), profile?.name ?? '—', isMe ? h('span', { class: 'badge' }, 'ви') : null);
}

function balancesCard(balances, profileOf) {
  return h('div', { class: 'card' },
    h('h2', {}, 'Баланси'),
    h('ul', { class: 'list' },
      balances.map(({ userId, balance }) =>
        h('li', { class: userId === currentUser.id ? 'is-me' : '' },
          personLabel(profileOf(userId)),
          h('span', { class: `amount ${balance > 0 ? 'pos' : balance < 0 ? 'neg' : 'sub'}` },
            balance > 0 ? `+${formatMoney(balance)}` : formatMoney(balance)),
        ),
      ),
    ),
  );
}

/**
 * Поточні курси з відкритого набору fawazahmed0/currency-api (оновлюється щодня).
 * Повертає { date, rateOf(code) } — «скільки base за 1 code». Кешуємо на 10 хвилин.
 */
const marketCache = new Map();
async function fetchMarketRates(base) {
  const key = base.toLowerCase();
  const cached = marketCache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.value;
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${key}.min.json`,
    `https://latest.currency-api.pages.dev/v1/currencies/${key}.min.json`, // запасне дзеркало
  ];
  let data = null;
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (response.ok) data = await response.json();
    } catch {
      // пробуємо наступне джерело
    }
    if (data?.[key]) break;
  }
  if (!data?.[key]) throw new Error('Не вдалося отримати курси з інтернету');
  const value = {
    date: data.date,
    rateOf(code) {
      const perBase = data[key][code.toLowerCase()];
      if (!perBase) return null;
      const rate = 1 / perBase;
      return Number(rate.toFixed(rate >= 10 ? 2 : 4)); // 44,77 грн за $, але 4,2513 zł за €
    },
  };
  marketCache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchMarketRate(code, base) {
  const rate = (await fetchMarketRates(base)).rateOf(code);
  if (!rate) throw new Error(`Курс ${code} не знайдено`);
  return rate;
}

/** Налаштування курсів групи: скільки основної валюти коштує 1 одиниця іншої. */
function ratesCard(group, rateRows, reload) {
  const base = group.currency;
  const baseSymbol = currencySymbol(base);
  const setRate = (currency, rate) => run(supabase.rpc('set_group_rate', { gid: group.id, currency, rate }));

  const rows = rateRows.map((r) => {
    const input = h('input', { value: formatRate(r.rate), inputMode: 'decimal', 'aria-label': `Курс ${r.currency}` });
    const save = h('button', { type: 'button', class: 'secondary', hidden: true }, 'Зберегти');
    input.addEventListener('input', () => { save.hidden = parseRate(input.value) === Number(r.rate); });
    save.addEventListener('click', async () => {
      const rate = parseRate(input.value);
      if (!rate) return toast('Вкажіть курс, напр. 41,25');
      save.disabled = true;
      try {
        await setRate(r.currency, rate);
        toast('Курс збережено');
        reload();
      } catch (err) {
        toast(err.message);
        save.disabled = false;
      }
    });
    return h('li', {},
      h('span', { class: 'rate-code' }, currencyLabel(r.currency)),
      h('div', { class: 'rate-row' },
        h('span', { class: 'sub' }, `1 ${currencySymbol(r.currency)} =`),
        input,
        h('span', { class: 'sub' }, baseSymbol),
        save,
        h('button', {
          type: 'button', class: 'link', title: 'Прибрати валюту',
          onClick: async () => {
            if (!confirm(`Прибрати ${r.currency}? Уже внесені витрати в цій валюті не зміняться.`)) return;
            try {
              await setRate(r.currency, null);
              reload();
            } catch (err) {
              toast(err.message);
            }
          },
        }, '✕'),
      ),
    );
  });

  const used = new Set([base, ...rateRows.map((r) => r.currency)]);
  const available = currencyList.filter((c) => !used.has(c.code));
  const error = h('div', { class: 'error' });
  const currencySelect = h('select', { name: 'currency', 'aria-label': 'Валюта' },
    available.map((c) => h('option', { value: c.code, title: c.name }, `${c.flag} ${c.code}`)));
  const rateInput = h('input', { name: 'rate', inputMode: 'decimal', placeholder: 'курс', required: true });
  // Під час вибору валюти одразу підставляємо поточний курс з інтернету (його можна виправити вручну).
  const marketNote = h('div', { class: 'sub' });
  let rateTouched = false;
  rateInput.addEventListener('input', () => { rateTouched = true; });
  async function fillMarketRate() {
    error.textContent = '';
    marketNote.textContent = 'Шукаю поточний курс…';
    const code = currencySelect.value;
    try {
      const market = await fetchMarketRates(base);
      const rate = market.rateOf(code);
      if (currencySelect.value !== code) return; // поки чекали, обрали іншу валюту
      if (!rate) throw new Error(`Курс ${code} не знайдено`);
      if (!rateTouched) rateInput.value = formatRate(rate);
      marketNote.textContent = `Курс з інтернету на ${formatDate(market.date)}: 1 ${currencySymbol(code)} = ${formatRate(rate)} ${baseSymbol}`;
    } catch (err) {
      marketNote.textContent = `${err.message}. Введіть курс вручну.`;
    }
  }
  currencySelect.addEventListener('change', () => {
    rateTouched = false;
    rateInput.value = '';
    fillMarketRate();
  });
  if (available.length > 0) fillMarketRate();

  const form = h('form', {},
    h('div', { class: 'add-rate' }, currencySelect, rateInput, h('button', { type: 'submit' }, 'Додати')),
    marketNote,
    error,
  );

  // Оновити всі курси групи з інтернету одним натиском.
  const refreshAll = rateRows.length > 0 && h('button', {
    type: 'button', class: 'secondary refresh-rates',
    onClick: async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      try {
        const market = await fetchMarketRates(base);
        const updates = rateRows.map((r) => [r.currency, market.rateOf(r.currency)]).filter(([, rate]) => rate);
        if (updates.length === 0) throw new Error('Курсів для цих валют не знайдено');
        await Promise.all(updates.map(([code, rate]) => setRate(code, rate)));
        toast(`Курси оновлено (на ${formatDate(market.date)})`);
        reload();
      } catch (err) {
        toast(err.message);
        button.disabled = false;
      }
    },
  }, '↻ Оновити курси з інтернету');
  form.addEventListener('submit', submitHandler(form, error, async (data) => {
    const rate = parseRate(data.get('rate'));
    if (!rate) throw new Error('Вкажіть курс, напр. 41,25');
    await setRate(String(data.get('currency')), rate);
    toast('Валюту додано');
    reload();
  }));

  return h('div', { class: 'card' },
    h('h2', {}, 'Курси валют'),
    h('p', { class: 'sub' },
      `Основна валюта групи — ${currencyLabel(base)} (${currencyInfo(base).name}). У ній рахуються баланси й борги. `
      + 'Витрату в іншій валюті перераховуємо за курсом на момент додавання; зміна курсу не переписує старі витрати.'),
    rows.length > 0 ? h('ul', { class: 'list rates' }, rows) : h('p', { class: 'empty' }, 'Інших валют ще немає.'),
    refreshAll,
    available.length > 0 && h('h3', {}, 'Додати валюту'),
    available.length > 0 && form,
  );
}

function transfersCard(groupId, transfers, nameOf, reload) {
  return h('div', { class: 'card' },
    h('h2', {}, 'Хто кому винен'),
    transfers.length === 0
      ? h('p', { class: 'empty' }, 'Усі розрахувалися 🎉')
      : h('ul', { class: 'list' },
        transfers.map((t) =>
          h('li', {},
            h('span', {}, h('strong', {}, nameOf(t.from)), ' → ', h('strong', {}, nameOf(t.to)),
              ' ', h('span', { class: 'amount' }, formatMoney(t.amount))),
            h('button', {
              class: 'secondary',
              title: 'Записати, що борг повернено',
              onClick: async (e) => {
                e.target.disabled = true;
                try {
                  await run(supabase.from('settlements').insert({
                    group_id: groupId, from_user: t.from, to_user: t.to, amount: t.amount,
                  }));
                  toast('Розрахунок записано');
                  reload();
                } catch (err) {
                  toast(err.message);
                  e.target.disabled = false;
                }
              },
            }, 'Сплачено'),
          ),
        ),
      ),
  );
}

function membersCard(group, members, reload) {
  const groupId = group.id;
  const error = h('div', { class: 'error' });
  const form = h('form', {},
    h('div', { class: 'row' },
      h('input', { name: 'email', type: 'email', placeholder: 'email зареєстрованого учасника', required: true }),
      h('button', { type: 'submit' }, 'Додати'),
    ),
    error,
  );
  form.addEventListener('submit', submitHandler(form, error, async (data) => {
    await run(supabase.rpc('add_group_member', { gid: groupId, member_email: data.get('email') }));
    toast('Учасника додано');
    reload();
  }));

  return h('div', { class: 'card' },
    h('h2', {}, `Учасники (${members.length})`),
    h('ul', { class: 'list' },
      members.map((m) =>
        h('li', { class: m.id === currentUser.id ? 'is-me' : '' },
          h('div', { class: 'person' },
            avatar(m),
            h('div', {},
              h('div', {}, m.name,
                m.id === currentUser.id ? h('span', { class: 'badge' }, 'ви') : null,
                m.id === group.created_by ? h('span', { class: 'badge muted' }, 'автор') : null),
              h('div', { class: 'sub' }, m.email),
            ),
          ),
          m.id !== currentUser.id &&
            h('button', {
              class: 'link',
              title: 'Видалити з групи',
              onClick: async () => {
                if (!confirm(`Видалити ${m.name} з групи?`)) return;
                try {
                  await run(supabase.rpc('remove_group_member', { gid: groupId, member: m.id }));
                  reload();
                } catch (err) {
                  toast(err.message);
                }
              },
            }, '✕'),
        ),
      ),
    ),
    invitePanel(group, form, reload, members),
  );
}

/** Кнопка «Запросити учасника», що розгортає посилання-запрошення та додавання за email. */
/**
 * «Люди, яких ви знаєте»: учасники інших ваших груп, яких ще немає в цій (адміну — усі користувачі).
 * Додаються одним натиском, без посилання й без введення email.
 */
function knownPeopleBlock(group, members, reload) {
  const box = h('div', { class: 'known-people' });
  const memberIds = new Set(members.map((m) => m.id));
  (async () => {
    const people = currentUser.isAdmin
      ? await run(supabase.rpc('admin_users'))
      : await run(supabase.from('profiles').select('id, name, email, avatar_path').order('name'));
    const candidates = people.filter((p) => !memberIds.has(p.id));
    if (candidates.length === 0) return;
    box.replaceChildren(
      h('h3', {}, 'Додати зі знайомих'),
      h('p', { class: 'sub' }, currentUser.isAdmin
        ? 'Усі зареєстровані користувачі, яких ще немає в групі (цей список бачите, бо ви адміністратор).'
        : 'Люди з ваших інших груп, яких ще немає в цій.'),
      h('ul', { class: 'list' }, candidates.map((p) =>
        h('li', {},
          h('div', { class: 'person' },
            avatar(p),
            h('div', {}, h('div', {}, p.name), h('div', { class: 'sub' }, p.email)),
          ),
          h('button', {
            type: 'button', class: 'secondary',
            onClick: async (e) => {
              const button = e.currentTarget;
              button.disabled = true;
              try {
                await run(supabase.rpc('add_group_member', { gid: group.id, member_email: p.email }));
                toast(`${p.name} — у групі`);
                reload();
              } catch (err) {
                toast(err.message);
                button.disabled = false;
              }
            },
          }, 'Додати'),
        ))),
    );
  })().catch(() => { /* список — лише підказка; без нього лишаються посилання й email */ });
  return box;
}

function invitePanel(group, emailForm, reload, members = []) {
  const body = h('div', { class: 'invite-body', id: `invite-${group.id}`, hidden: !groupUi.inviteOpen },
    knownPeopleBlock(group, members, reload),
    inviteBlock(group, reload),
    h('p', { class: 'sub' }, 'Або додайте за email, якщо людина вже зареєстрована:'),
    emailForm,
  );
  const toggle = h('button', {
    type: 'button',
    class: 'secondary invite-toggle',
    'aria-expanded': String(groupUi.inviteOpen),
    'aria-controls': body.id,
    onClick: () => {
      groupUi.inviteOpen = !groupUi.inviteOpen;
      body.hidden = !groupUi.inviteOpen;
      toggle.setAttribute('aria-expanded', String(groupUi.inviteOpen));
      toggle.textContent = groupUi.inviteOpen ? 'Сховати запрошення' : '➕ Запросити учасника';
    },
  }, groupUi.inviteOpen ? 'Сховати запрошення' : '➕ Запросити учасника');
  return h('div', {}, toggle, body);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function inviteBlock(group, reload) {
  const link = inviteLink(group.invite_token);
  const input = h('input', { value: link, readOnly: true, 'aria-label': 'Посилання-запрошення', onFocus: (e) => e.target.select() });
  const share = async () => {
    try {
      await navigator.share({
        title: 'Спільні витрати',
        text: `Приєднуйся до групи «${group.name}» у «Спільних витратах»`,
        url: link,
      });
    } catch { /* користувач закрив вікно — нічого не робимо */ }
  };
  return h('div', { class: 'invite' },
    h('h3', {}, 'Запросити за посиланням'),
    h('p', { class: 'sub' }, 'Надішліть це посилання другу — він зареєструється й одразу потрапить у групу.'),
    h('div', { class: 'row' },
      input,
      h('div', { class: 'actions' },
        h('button', {
          type: 'button',
          onClick: async () => {
            if (await copyText(link)) toast('Посилання скопійовано');
            else { input.focus(); input.select(); toast('Скопіюйте виділене посилання'); }
          },
        }, 'Копіювати'),
        typeof navigator.share === 'function' && h('button', { type: 'button', class: 'secondary', onClick: share }, 'Надіслати'),
      ),
    ),
    h('button', {
      type: 'button',
      class: 'link',
      onClick: async () => {
        if (!confirm('Створити нове посилання? Старе перестане працювати.')) return;
        try {
          await run(supabase.rpc('reset_group_invite', { gid: group.id }));
          toast('Створено нове посилання');
          reload();
        } catch (err) {
          toast(err.message);
        }
      },
    }, 'Створити нове посилання'),
  );
}

// ---------- Приєднання за посиланням ----------

async function renderJoin(token) {
  const [invite] = await run(supabase.rpc('get_group_invite', { token }));
  if (!invite) {
    pendingInvite.clear();
    mount(h('div', { class: 'card auth' },
      h('h1', {}, 'Посилання недійсне'),
      h('p', {}, 'Можливо, його замінили новим. Попросіть учасника групи надіслати свіже посилання.'),
      h('a', { href: '#/' }, '← На головну'),
    ));
    return;
  }
  if (!currentUser) {
    pendingInvite.set(token);
    renderAuth(invite);
    return;
  }
  if (invite.already_member) {
    pendingInvite.clear();
    location.hash = `#/groups/${invite.group_id}`;
    return;
  }

  const join = async () => {
    const groupId = await run(supabase.rpc('join_group', { token }));
    pendingInvite.clear();
    toast(`Ви приєдналися до групи «${invite.name}»`);
    location.hash = `#/groups/${groupId}`;
  };
  // Людина щойно зареєструвалась/увійшла саме заради цього запрошення — приєднуємо одразу.
  if (pendingInvite.get() === token) {
    await join();
    return;
  }

  const error = h('div', { class: 'error' });
  const button = h('button', {
    onClick: async () => {
      button.disabled = true;
      error.textContent = '';
      try {
        await join();
      } catch (err) {
        error.textContent = err.message;
        button.disabled = false;
      }
    },
  }, 'Приєднатися');
  mount(h('div', { class: 'card auth' },
    h('h1', {}, 'Запрошення'),
    h('p', {}, 'Вас запрошено до групи ', h('strong', {}, `«${invite.name}»`), ` (${invite.member_count} учасн.).`),
    error,
    button,
    h('p', {}, h('a', { href: '#/' }, 'Не зараз')),
  ));
}


/** Скільки фото можна прикріпити до витрати. */
const MAX_PHOTOS = 2;

/**
 * Блок «Фото» у формі витрати: до двох фото (чек, товар…) — сфотографувати чи вибрати й переглянути.
 * existingUrls — посилання на вже прикріплені фото [фото 1, фото 2].
 * Повертає елемент і стан слотів: [{ url, file, removed }] — нове фото чи прибране наявне.
 */
function receiptField(existingUrls) {
  const slots = Array.from({ length: MAX_PHOTOS }, (_, i) => ({ url: existingUrls[i] ?? null, file: null, removed: false }));
  const previews = new Map();
  const hasPhoto = (slot) => Boolean(slot.file || (slot.url && !slot.removed));
  const freeSlots = () => slots.filter((slot) => !hasPhoto(slot));

  const pick = (capture) => {
    const input = h('input', { type: 'file', accept: 'image/*', capture, multiple: !capture, hidden: true });
    input.addEventListener('change', () => {
      const files = [...input.files];
      input.remove();
      const free = freeSlots();
      if (files.length > free.length) toast(`Можна додати ще ${free.length} фото — зайві пропущено`);
      files.slice(0, free.length).forEach((file, i) => {
        free[i].file = file;
        free[i].removed = false;
      });
      open = true;
      render();
    });
    document.body.append(input); // деякі браузери не відкривають вибір файлу для від'єднаного input
    input.click();
  };

  const box = h('div', { class: 'receipt' });

  function imageOf(slot) {
    if (slot.file) {
      if (!previews.has(slot.file)) previews.set(slot.file, URL.createObjectURL(slot.file));
      return previews.get(slot.file);
    }
    return slot.url;
  }

  // Блок згорнутий: відкривається натиском на рядок «📷 Фото», коли фото справді потрібні.
  let open = false;
  function render() {
    const filled = slots.filter(hasPhoto);
    const toggle = h('button', {
      type: 'button', class: 'receipt-toggle', 'aria-expanded': String(open),
      onClick: () => { open = !open; render(); },
    },
    h('span', { class: 'receipt-toggle-icon', 'aria-hidden': 'true' }, '📷'),
    h('span', { class: 'receipt-toggle-text' },
      h('span', {}, 'Фото чека чи покупки'),
      h('span', { class: 'sub' }, filled.length > 0 ? `прикріплено: ${filled.length} з ${MAX_PHOTOS}` : `необов'язково, до ${MAX_PHOTOS}`)),
    filled.length > 0 ? h('span', { class: 'receipt-count' }, String(filled.length)) : null,
    h('span', { class: 'chevron', 'aria-hidden': 'true' }, '›'));
    box.classList.toggle('open', open);
    if (!open) {
      box.replaceChildren(toggle);
      return;
    }
    const parts = [
      toggle,
      filled.length > 0 && photoCarousel(filled.map((slot) => ({
        src: imageOf(slot),
        onRemove: () => {
          slot.file = null;
          slot.removed = true;
          render();
        },
      }))),
      freeSlots().length > 0 && h('div', { class: 'receipt-actions' },
        h('button', { type: 'button', class: 'secondary', onClick: () => pick('environment') }, '📷 Сфотографувати'),
        h('button', { type: 'button', class: 'secondary', onClick: () => pick(null) }, filled.length > 0 ? '🖼 Додати ще фото' : '🖼 Вибрати фото'),
      ),
    ];
    box.replaceChildren(...parts.filter(Boolean));
  }
  render();
  return { el: box, state: slots };
}

/** Зберігає зміни фото витрати: завантажує нові, прибирає видалені; старі файли видаляє зі сховища. */
async function saveReceipt(groupId, expenseId, slots) {
  const oldPaths = [];
  for (const [i, slot] of slots.entries()) {
    if (!slot.file && !slot.removed) continue;
    let path = null;
    if (slot.file) {
      path = `${groupId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`;
      await run(supabase.storage.from('receipts').upload(path, await scaledJpeg(slot.file), { contentType: 'image/jpeg' }));
    }
    const oldPath = await run(supabase.rpc('set_expense_photo', { expense_id: expenseId, slot: i + 1, photo_path: path }));
    if (oldPath) oldPaths.push(oldPath);
  }
  if (oldPaths.length > 0) await supabase.storage.from('receipts').remove(oldPaths);
}

/** Форма нової витрати; якщо передано editing — редагування цієї витрати. */
function expenseFormCard(groupId, members, categories, rates, reload, editing = null, onCancel = null) {
  const error = h('div', { class: 'error' });

  // Валюта витрати: основна або будь-яка з курсом у налаштуваннях групи.
  // Під час редагування в тій самій валюті лишається курс, збережений у витраті.
  const currencies = [baseCurrency, ...rates.keys()];
  if (editing?.currency && !currencies.includes(editing.currency)) currencies.push(editing.currency);
  const rateFor = (code) => (code === baseCurrency ? 1
    : code === editing?.currency ? editing.rate : rates.get(code));
  const currencySelect = h('select', { name: 'currency', 'aria-label': 'Валюта', hidden: currencies.length === 1 },
    currencies.map((code) => h('option', { value: code, selected: code === (editing?.currency ?? baseCurrency) }, currencyLabel(code))));
  const cur = () => currencySelect.value;

  // Під час редагування: якщо частки — це рівний поділ між тими, хто бере участь, показуємо «Порівну».
  // Частки зберігаються в основній валюті — для витрати в іншій валюті переводимо їх назад.
  const editShares = editing?.currency
    ? convertShares(editing.shares, 1 / editing.rate, editing.originalAmount)
    : editing?.shares ?? [];
  const shareOf = new Map(editShares.map((s) => [s.userId, s.amount]));
  const participantIds = members.filter((m) => shareOf.get(m.id) > 0).map((m) => m.id);
  const baseAmounts = (editing?.shares ?? []).map((s) => s.amount);
  const isEqual = !editing || (participantIds.length > 0 && participantIds.length === shareOf.size
    && Math.max(...baseAmounts) - Math.min(...baseAmounts) <= 1);

  const splitType = h('select', { name: 'splitType' },
    h('option', { value: 'equal', selected: isEqual }, 'Порівну'),
    h('option', { value: 'exact', selected: !isEqual }, 'Точними сумами'),
  );
  const equalBox = h('div', { class: 'checks', hidden: !isEqual },
    members.map((m) =>
      h('label', {}, h('input', {
        type: 'checkbox', name: 'participant', value: String(m.id),
        checked: !editing || !isEqual || participantIds.includes(m.id),
      }), avatar(m, 'xs'), memberName(m)),
    ),
  );

  // Точні суми: залишок автоматично підставляється в останнє поле, яке користувач не заповнював сам.
  const amountInput = h('input', {
    name: 'amount', required: true, inputMode: 'decimal', placeholder: '0,00',
    value: editing ? formatInput(editing.originalAmount ?? editing.amount) : '',
  });
  // Підказка з перерахунком в основну валюту.
  const convertHint = h('div', { class: 'sub convert-hint' });
  function updateConvertHint() {
    const code = cur();
    const amount = parseMoney(amountInput.value);
    convertHint.hidden = code === baseCurrency;
    if (convertHint.hidden) return;
    const rate = rateFor(code);
    convertHint.textContent = `${amount ? `≈ ${formatMoney(convertAmount(amount, rate))} · ` : ''}`
      + `1 ${currencySymbol(code)} = ${formatRate(rate)} ${currencySymbol(baseCurrency)}`
      + (code === editing?.currency ? ' (курс цієї витрати)' : '');
  }
  const shareInputs = members.map((m) => h('input', {
    name: `share-${m.id}`, inputMode: 'decimal', placeholder: '0,00',
    value: editing && !isEqual && shareOf.get(m.id) ? formatInput(shareOf.get(m.id)) : '',
  }));
  // Частки витрати, що редагується, вважаємо введеними вручну.
  const manual = new Set(shareInputs.flatMap((input, i) => (input.value ? [i] : [])));
  const shareHint = h('div', { class: 'sub' });
  function updateShares() {
    const amount = parseMoney(amountInput.value);
    const entries = shareInputs.map((input, i) => ({ manual: manual.has(i), value: parseMoney(input.value) }));
    shareInputs.forEach((input, i) => {
      if (manual.has(i)) return;
      input.value = '';
      input.classList.remove('auto');
    });
    const auto = remainderShare(amount, entries);
    if (auto && auto.value !== null) {
      shareInputs[auto.index].value = formatInput(auto.value);
      shareInputs[auto.index].classList.add('auto');
    }
    const rest = amount === null ? null : amount - shareInputs.reduce((sum, input) => sum + (parseMoney(input.value) ?? 0), 0);
    shareHint.className = rest === null || rest === 0 ? 'sub' : 'sub neg';
    shareHint.textContent = rest === null ? 'Спершу вкажіть суму витрати'
      : rest === 0 ? '✓ Усю суму розподілено'
      : rest > 0 ? `Залишилось розподілити: ${formatMoney(rest, cur())}`
      : `Частки більші за суму на ${formatMoney(-rest, cur())}`;
  }
  shareInputs.forEach((input, i) => input.addEventListener('input', () => {
    if (input.value.trim()) manual.add(i);
    else manual.delete(i);
    updateShares();
  }));
  amountInput.addEventListener('input', () => {
    updateShares();
    updateConvertHint();
  });
  currencySelect.addEventListener('change', () => {
    updateShares();
    updateConvertHint();
  });
  updateConvertHint();

  const exactBox = h('div', { class: 'shares', hidden: isEqual },
    members.map((m, i) => h('label', {}, h('span', { class: 'person' }, avatar(m, 'xs'), memberName(m)), shareInputs[i])),
    shareHint,
  );
  splitType.addEventListener('change', () => {
    equalBox.hidden = splitType.value !== 'equal';
    exactBox.hidden = splitType.value !== 'exact';
    updateShares();
  });

  const descriptionInput = h('input', {
    name: 'description', required: true, maxLength: 200, placeholder: 'Напр. «Продукти»', value: editing?.description ?? '',
  });
  const receipt = receiptField(editing?.photoUrls ?? []);

  const form = h('form', {},
    receipt.el,
    h('label', {}, 'Опис', descriptionInput),
    h('div', { class: 'row' },
      h('label', {}, 'Сума', h('div', { class: 'amount-field' }, amountInput, currencySelect), convertHint),
      h('label', {}, 'Дата', h('input', { name: 'date', type: 'date', value: editing?.date ?? today() })),
    ),
    categories.length > 0 && h('label', {}, 'Тег',
      h('select', { name: 'category' },
        h('option', { value: '' }, 'Без тегу'),
        categories.map((c) => h('option', { value: String(c.id), selected: c.id === editing?.categoryId }, categoryLabel(c))),
      ),
    ),
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, 'Хто платив'),
      h('div', { class: 'checks pick' },
        members.map((m) =>
          h('label', {}, h('input', {
            type: 'radio', name: 'paidBy', value: String(m.id), checked: m.id === (editing?.paidBy ?? currentUser.id),
          }), avatar(m, 'xs'), memberName(m)),
        ),
      ),
    ),
    h('label', {}, 'Як ділити', splitType),
    equalBox,
    exactBox,
    error,
    editing
      ? h('div', { class: 'row' },
        h('button', { type: 'submit' }, 'Зберегти зміни'),
        h('button', { type: 'button', class: 'secondary', onClick: () => onCancel?.() }, 'Скасувати'),
      )
      : h('button', { type: 'submit' }, 'Додати витрату'),
  );
  if (editing) updateShares();

  form.addEventListener('submit', submitHandler(form, error, async (data) => {
    const original = parseMoney(data.get('amount'));
    if (!original) throw new Error('Вкажіть коректну суму, напр. 150 або 99,90');
    const code = cur();
    const rate = rateFor(code);
    const amount = convertAmount(original, rate); // в основній валюті

    let shares;
    if (data.get('splitType') === 'equal') {
      const participants = data.getAll('participant').map(String);
      if (participants.length === 0) throw new Error('Оберіть хоча б одного учасника');
      shares = splitEqually(amount, participants);
    } else {
      shares = [];
      for (const m of members) {
        const raw = String(data.get(`share-${m.id}`) ?? '').trim();
        if (!raw) continue;
        const value = parseMoney(raw);
        if (value === null) throw new Error(`Некоректна частка для ${m.name}`);
        shares.push({ userId: m.id, amount: value });
      }
      const total = shares.reduce((s, x) => s + x.amount, 0);
      if (total !== original) {
        throw new Error(`Сума часток (${formatMoney(total, code)}) не дорівнює сумі витрати (${formatMoney(original, code)})`);
      }
      if (code !== baseCurrency) shares = convertShares(shares, rate, amount);
    }

    const fields = {
      description: String(data.get('description')).trim(),
      amount,
      paid_by: String(data.get('paidBy')),
      shares: shares.map((s) => ({ user_id: s.userId, amount: s.amount })),
      expense_date: data.get('date') || today(),
      category_id: data.get('category') ? Number(data.get('category')) : null,
      expense_currency: code === baseCurrency ? null : code,
      original_amount: code === baseCurrency ? null : original,
    };
    let expenseId = editing?.id;
    if (editing) await run(supabase.rpc('update_expense', { expense_id: editing.id, ...fields }));
    else expenseId = await run(supabase.rpc('add_expense', { gid: groupId, ...fields }));
    try {
      await saveReceipt(groupId, expenseId, receipt.state);
      toast(editing ? 'Зміни збережено' : 'Витрату додано');
    } catch (err) {
      toast(`Витрату збережено, але фото квитанції — ні: ${err.message}`);
    }
    reload();
  }));

  return h('div', { class: editing ? 'card editing' : 'card' },
    h('h2', {}, editing ? `Редагування: «${editing.description}»` : 'Нова витрата'),
    form,
  );
}

function settlementFormCard(groupId, members, reload) {
  const error = h('div', { class: 'error' });
  const others = members.filter((m) => m.id !== currentUser.id);
  const memberOptions = (selectedId) =>
    members.map((m) => h('option', { value: String(m.id), selected: m.id === selectedId }, m.name));

  const form = h('form', {},
    h('div', { class: 'row' },
      h('label', {}, 'Хто віддав', h('select', { name: 'fromUser' }, memberOptions(currentUser.id))),
      h('label', {}, 'Кому', h('select', { name: 'toUser' }, memberOptions(others[0]?.id))),
    ),
    h('div', { class: 'row' },
      h('label', {}, `Сума, ${currencySymbol(baseCurrency)}`, h('input', { name: 'amount', required: true, inputMode: 'decimal', placeholder: '0,00' })),
      h('label', {}, 'Дата', h('input', { name: 'date', type: 'date', value: today() })),
    ),
    error,
    h('button', { type: 'submit' }, 'Записати переказ'),
  );
  form.addEventListener('submit', submitHandler(form, error, async (data) => {
    const amount = parseMoney(data.get('amount'));
    if (!amount) throw new Error('Вкажіть коректну суму');
    const fromUser = String(data.get('fromUser'));
    const toUser = String(data.get('toUser'));
    if (fromUser === toUser) throw new Error('Оберіть двох різних учасників');
    await run(supabase.from('settlements').insert({
      group_id: groupId,
      from_user: fromUser,
      to_user: toUser,
      amount,
      date: data.get('date') || today(),
    }));
    toast('Переказ записано');
    reload();
  }));

  return h('div', { class: 'card' }, h('h2', {}, 'Повернення боргу'), form);
}

/** Пігулка «аватар + ім'я (+ сума)» — як у формі витрати. */
function personPill(profile, amount = null) {
  return h('span', { class: 'pill' }, avatar(profile, 'xs'), memberName(profile),
    amount === null ? null : h('span', { class: 'pill-amount' }, formatMoney(amount)));
}

/** Сума без знака валюти («1 000,50») — для колонок, де валюта вказана в заголовку. */
const formatPlain = (kopecks) => (kopecks / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Частка поточного користувача у витраті (у копійках основної валюти); 0 — не бере участі. */
const myShareOf = (e) => e.shares.find((s) => s.userId === currentUser.id)?.amount ?? 0;

/** Колонка «Ваша частка» в рядку витрати. */
function myShareCell(e) {
  const mine = myShareOf(e);
  return h('div', { class: 'expense-mine', title: 'Ваша частка в цій витраті' },
    mine > 0 ? h('span', { class: 'amount mine' }, formatPlain(mine)) : h('span', { class: 'amount sub' }, '—'),
    e.paidBy === currentUser.id ? h('div', { class: 'sub' }, 'ви платили') : null);
}

function expensesCard(groupId, allExpenses, profileOf, reload, onEdit) {
  const f = groupUi.expenseFilter;
  const expenseItem = (e) => {
    // Рівний поділ: частки відрізняються щонайбільше на копійку (залишок від ділення).
    const amounts = e.shares.map((s) => s.amount);
    const isEqual = amounts.length > 0 && Math.max(...amounts) - Math.min(...amounts) <= 1;
    const details = h('details', { class: 'expense', open: groupUi.openExpenses.has(e.id) },
      h('summary', {},
        h('div', { class: 'expense-main' },
          h('div', { class: 'expense-title' }, e.description),
          h('div', { class: 'sub' }, formatDate(e.date)),
        ),
        // Колонка «Сума» — в основній валюті (знак у заголовку); для іншої валюти під нею — сума у валюті.
        h('div', { class: 'expense-amount' },
          h('span', { class: 'amount' }, formatPlain(e.amount)),
          e.currency ? h('div', { class: 'sub' }, formatMoney(e.originalAmount, e.currency)) : null,
        ),
        myShareCell(e),
        h('span', { class: 'chevron', 'aria-hidden': 'true' }, '›'),
        // Теги — окремим рядком на всю ширину, щоб довгі назви вміщались повністю.
        (e.category || e.photoUrls.some(Boolean)) ? h('div', { class: 'expense-meta' },
          e.category ? h('span', { class: 'tag' }, categoryLabel(e.category)) : null,
          e.photoUrls.some(Boolean) ? h('span', { class: 'tag tag-photo', title: 'Є фото' }, `📷 ${e.photoUrls.filter(Boolean).length}`) : null) : null,
      ),
      h('div', { class: 'expense-body' },
        e.photoUrls.some(Boolean) && photoCarousel(e.photoUrls.filter(Boolean).map((src) => ({ src }))),
        h('div', { class: 'field' },
          h('span', { class: 'field-label' }, 'Хто платив'),
          h('div', { class: 'pills' }, personPill(profileOf(e.paidBy))),
        ),
        h('div', { class: 'field' },
          h('span', { class: 'field-label' }, isEqual ? 'Ділили порівну' : 'Ділили точними сумами'),
          h('div', { class: 'pills' }, e.shares.map((s) => personPill(profileOf(s.userId), s.amount))),
        ),
        e.currency ? h('div', { class: 'sub' },
          `${currencyLabel(e.currency)} → ${currencyLabel(baseCurrency)}: 1 ${currencySymbol(e.currency)} = ${formatRate(e.rate)} ${currencySymbol(baseCurrency)}`) : null,
        h('div', { class: 'expense-actions' },
          e.edited ? h('span', { class: 'sub' }, 'змінено') : null,
          h('button', { class: 'link edit', title: 'Редагувати витрату', onClick: () => onEdit(e) }, '✎ Редагувати'),
          h('button', {
            class: 'link',
            title: 'Видалити витрату',
            onClick: async () => {
              if (!confirm(`Видалити витрату «${e.description}»?`)) return;
              try {
                await run(supabase.from('expenses').delete().eq('id', e.id));
                const paths = e.photoPaths.filter(Boolean);
                if (paths.length > 0) await supabase.storage.from('receipts').remove(paths);
              } catch (err) {
                toast(err.message);
              }
              reload();
            },
          }, '✕ Видалити'),
        ),
      ),
    );
    // Розгорнуті витрати лишаються розгорнутими після оновлення сторінки групи.
    details.addEventListener('toggle', () => {
      if (details.open) groupUi.openExpenses.add(e.id);
      else groupUi.openExpenses.delete(e.id);
    });
    return h('li', {}, details);
  };

  // Ширина колонок — за найдовшою сумою (вимірюємо реальним шрифтом), щоб шапка, рядки й «Разом» стояли рівно.
  const expenses = allExpenses; // ширини — за всіма витратами, щоб колонки не «стрибали» під час пошуку
  const measure = h('canvas').getContext('2d');
  measure.font = `700 15px ${getComputedStyle(document.body).fontFamily}`;
  const longest = (texts) => Math.max(...texts.map((t) => measure.measureText(t).width));
  const amountTexts = [formatPlain(expenses.reduce((sum, e) => sum + e.amount, 0)), ...expenses.map((e) => formatPlain(e.amount))];
  const mineTexts = [formatPlain(expenses.reduce((sum, e) => sum + myShareOf(e), 0))];
  // Заголовки колонок — дрібнішим шрифтом, міряємо окремо.
  const headerFont = `600 12px ${getComputedStyle(document.body).fontFamily}`;
  const headerWidth = (text) => { measure.font = headerFont; const w = measure.measureText(text).width; measure.font = `700 15px ${getComputedStyle(document.body).fontFamily}`; return w; };
  const amountHeader = `Сума, ${currencySymbol(baseCurrency)}`;
  const mineHeader = 'Ваша частка';
  // Результати пошуку/фільтрів перемальовуються окремо — поле пошуку не втрачає фокус.
  const results = h('div', {});
  const renderResults = () => {
    const shown = filterExpenses(allExpenses, f, {
      meId: currentUser.id,
      nameOf: (id) => profileOf(id).name,
      categoryName: (id) => allExpenses.find((e) => e.categoryId === id)?.category?.name ?? '',
    }, today());
    results.replaceChildren(...(shown.length === 0
      ? [h('div', { class: 'filter-empty' }, 'Нічого не знайдено — змініть пошук чи фільтри.')]
      : [
        h('ul', { class: 'list expenses' }, shown.map(expenseItem)),
        h('div', { class: 'expense-cols expense-total' },
          h('span', {}, isFiltered(f) ? `Знайдено (${shown.length} з ${allExpenses.length})` : `Разом (${shown.length})`),
          h('span', { class: 'amount' }, formatPlain(shown.reduce((sum, e) => sum + e.amount, 0))),
          h('span', { class: 'amount mine' }, formatPlain(shown.reduce((sum, e) => sum + myShareOf(e), 0))),
          h('span', {})),
      ]));
  };

  // Теги й платники — лише ті, що трапляються у витратах групи.
  const usedCategories = [...new Map(allExpenses.filter((e) => e.category).map((e) => [e.categoryId, e.category])).values()];
  const payers = [...new Set(allExpenses.map((e) => e.paidBy))];
  const bar = allExpenses.length > 1 && filterBar(f, renderResults, {
    placeholder: 'Пошук: опис, тег, хто платив, сума',
    extras: (state, update) => [
      h('div', { class: 'row filter-selects' },
        usedCategories.length > 0 && filterSelect('Тег', state.categoryId, [
          ['', 'Усі теги'], ...usedCategories.map((c) => [String(c.id), categoryLabel(c)]), ['none', 'Без тегу'],
        ], (v) => { state.categoryId = v; update(); }),
        filterSelect('Хто платив', state.payerId, [
          ['', 'Усі'], ...payers.map((id) => [id, id === currentUser.id ? `${profileOf(id).name} (ви)` : profileOf(id).name]),
        ], (v) => { state.payerId = v; update(); }),
      ),
      h('label', { class: 'filter-switch' },
        h('input', {
          type: 'checkbox', checked: Boolean(state.onlyMine),
          onChange: (e) => { state.onlyMine = e.target.checked; update(); },
        }),
        'Лише мої витрати (я платив чи маю частку)'),
    ],
  });
  renderResults();

  const card = h('div', { class: 'card' },
    h('h2', {}, 'Витрати'),
    allExpenses.length === 0
      ? h('p', { class: 'empty' }, 'Витрат ще немає.')
      : [
        bar,
        h('div', { class: 'expense-cols', 'aria-hidden': 'true' },
          h('span', {}), h('span', {}, amountHeader), h('span', {}, mineHeader), h('span', {})),
        results,
      ],
  );
  if (expenses.length > 0) {
    card.style.setProperty('--amount-w', `${Math.ceil(Math.max(longest(amountTexts), headerWidth(amountHeader))) + 2}px`);
    card.style.setProperty('--mine-w', `${Math.ceil(Math.max(longest(mineTexts), headerWidth(mineHeader))) + 2}px`);
  }
  return card;
}

function settlementsCard(groupId, settlements, nameOf, reload) {
  if (settlements.length === 0) return null;
  return h('div', { class: 'card' },
    h('h2', {}, 'Перекази'),
    h('ul', { class: 'list' },
      settlements.map((s) =>
        h('li', {},
          h('div', {},
            h('div', {}, `${nameOf(s.fromUser)} → ${nameOf(s.toUser)}`),
            h('div', { class: 'sub' }, formatDate(s.date)),
          ),
          h('div', { class: 'actions' },
            h('span', { class: 'amount' }, formatMoney(s.amount)),
            h('button', {
              class: 'link',
              title: 'Скасувати переказ',
              onClick: async () => {
                if (!confirm('Скасувати цей переказ?')) return;
                await run(supabase.from('settlements').delete().eq('id', s.id)).catch((err) => toast(err.message));
                reload();
              },
            }, '✕'),
          ),
        ),
      ),
    ),
  );
}

// ---------- Маршрутизація ----------

async function route() {
  const hash = location.hash || '#/';
  tabbar.hidden = true; // показуємо лише на розділах для залогіненого користувача
  document.body.classList.remove('has-tabbar');
  try {
    if (!currentUser) {
      currentUser = await loadCurrentUser();
      renderUserbox();
    }
    if (hash === '#/reset-password') {
      if (currentUser) renderResetPassword();
      else {
        toast('Посилання недійсне або застаріло — запросіть новий лист');
        location.hash = '#/login';
      }
      return;
    }
    const joinMatch = hash.match(/^#\/join\/([0-9a-f-]{36})$/i);
    if (joinMatch) {
      await renderJoin(joinMatch[1].toLowerCase());
      return;
    }
    // Після підтвердження email людина повертається на головну — довершуємо запрошення.
    const pending = pendingInvite.get();
    if (currentUser && pending) {
      location.hash = `#/join/${pending}`;
      return;
    }
    if (!currentUser && hash !== '#/login') {
      location.hash = '#/login';
      return;
    }
    if (hash === '#/login') {
      if (currentUser) location.hash = '#/';
      else renderAuth();
      return;
    }
    const groupMatch = hash.match(/^#\/groups\/(\d+)$/);
    renderTabbar(groupMatch || hash === '#/archive' || hash === '#/profile' || hash === '#/admin' ? hash : '#/');
    if (hash === '#/profile') renderProfile();
    else if (hash === '#/archive') await renderGroups(true);
    else if (hash === '#/admin') await renderAdmin();
    else if (groupMatch) await renderGroup(Number(groupMatch[1]));
    else await renderGroups();
  } catch (err) {
    mount(
      h('div', { class: 'card' }, h('p', { class: 'error' }, err.message), h('a', { href: '#/' }, '← На головну')),
    );
  }
}

async function start() {
  if (!supabase) {
    mount(
      h('div', { class: 'card' },
        h('h1', {}, 'Застосунок ще не налаштовано'),
        h('p', {}, 'Вкажіть Project URL та anon key вашого проєкту Supabase у файлі public/config.js.'),
      ),
    );
    return;
  }
  loadSiteMeta(); // логотип і дизайн — паралельно з рештою
  // Після переходу за посиланням з листа Supabase повертає токен у #…; getSession() його обробляє.
  await supabase.auth.getSession();
  if (/access_token|error_description/.test(location.hash)) {
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.get('error_description')) toast(params.get('error_description'));
    history.replaceState(null, '', `${location.pathname}#/`);
  }
  if (passwordRecovery) history.replaceState(null, '', `${location.pathname}#/reset-password`);
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY' && location.hash !== '#/reset-password') location.hash = '#/reset-password';
    if (event === 'SIGNED_OUT') {
      currentUser = null;
      userDesign = null;
      refreshDesign();
      renderUserbox();
      renderTabbar('');
    }
  });
  window.addEventListener('hashchange', route);
  route();
}

start();
