// Клієнтська частина: невеликий SPA без фреймворків; дані зберігаються в Supabase.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { computeBalances, remainderShare, simplifyDebts, splitEqually } from './balances.js';
import { filterByPeriod, summarize } from './analytics.js';
import { parseReceipt } from './receipt.js';

const configured = SUPABASE_URL.startsWith('https://') && !SUPABASE_ANON_KEY.includes('ВСТАВТЕ');
const supabase = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const app = document.getElementById('app');
const userbox = document.getElementById('userbox');
const toastEl = document.getElementById('toast');
const tabbar = document.getElementById('tabbar');

let currentUser = null;

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

const moneyFormat = new Intl.NumberFormat('uk-UA', { style: 'currency', currency: 'UAH' });
const formatMoney = (kopecks) => moneyFormat.format(kopecks / 100);
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
  const [profile, isAdmin] = await Promise.all([
    run(supabase.from('profiles').select('id, name, email, avatar_path').eq('id', session.user.id).maybeSingle()),
    run(supabase.rpc('am_i_admin')).catch(() => false),
  ]);
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

// ---------- Розпізнавання квитанцій (Tesseract.js, прямо в браузері, безкоштовно) ----------

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';
let tesseractLoading = null;

/** Підвантажує бібліотеку розпізнавання лише тоді, коли вона вперше знадобилась. */
function loadTesseract() {
  tesseractLoading ??= new Promise((resolve, reject) => {
    const script = h('script', { src: TESSERACT_URL });
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => {
      tesseractLoading = null;
      reject(new Error('Не вдалося завантажити розпізнавання. Перевірте інтернет.'));
    };
    document.head.append(script);
  });
  return tesseractLoading;
}

/** Фото (Blob або URL) → текст квитанції. onProgress отримує рядок стану для показу. */
async function recognizeText(image, onProgress) {
  onProgress('Завантажую розпізнавання… (перший раз — кілька секунд)');
  const Tesseract = await loadTesseract();
  const worker = await Tesseract.createWorker(['ukr', 'eng'], 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') onProgress(`Розпізнаю текст… ${Math.round(m.progress * 100)}%`);
    },
  });
  try {
    const { data } = await worker.recognize(image);
    return data.text;
  } finally {
    await worker.terminate();
  }
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
  );
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
  const [categories, users] = await Promise.all([
    run(supabase.from('categories').select('id, name, icon, sort_order').order('sort_order').order('id')),
    run(supabase.rpc('admin_users')),
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
    const saveButton = h('button', { type: 'submit', class: 'secondary' }, 'Зберегти');
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

  mount(
    h('p', {}, h('a', { href: '#/' }, '← Усі групи')),
    h('h1', {}, 'Адмінка'),
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

// ---------- Вхід / реєстрація ----------

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
  const tabLogin = h('button', { type: 'button', onClick: () => setMode('login') }, 'Вхід');
  const tabRegister = h('button', { type: 'button', onClick: () => setMode('register') }, 'Реєстрація');

  function setMode(next) {
    mode = next;
    nameField.hidden = mode === 'login';
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

  setMode(mode);
  mount(
    h('div', { class: 'card auth' },
      h('h1', {}, 'Ласкаво просимо'),
      invite
        ? h('p', { class: 'invite-banner' },
          'Вас запрошено до групи ', h('strong', {}, `«${invite.name}»`),
          '. Зареєструйтесь або увійдіть — і ви одразу потрапите в групу.')
        : h('p', { class: 'sub' }, 'Ведіть спільні витрати з друзями, сусідами чи колегами та дізнавайтеся, хто кому скільки винен.'),
      h('div', { class: 'tabs' }, tabLogin, tabRegister),
      form,
    ),
  );
}

// ---------- Список груп ----------

function balanceLabel(balance) {
  if (balance > 0) return h('span', { class: 'amount pos' }, `вам винні ${formatMoney(balance)}`);
  if (balance < 0) return h('span', { class: 'amount neg' }, `ви винні ${formatMoney(-balance)}`);
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
async function renderGroups(showArchive = false) {
  const allGroups = (await run(supabase.rpc('group_list'))).map((g) => ({
    id: g.id,
    name: g.name,
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

  const groupItem = (g) =>
    h('li', {},
      h('div', { class: 'group-info' },
        h('a', { class: 'group-name', href: `#/groups/${g.id}` }, g.name),
        h('div', { class: 'group-meta' },
          avatarStack(membersOf(g.id)),
          h('span', { class: 'sub' }, `${g.memberCount} учасн.`),
        ),
        h('div', { class: 'created' }, `створено ${formatCreated(g.createdAt)}`),
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
        : balanceLabel(g.myBalance),
    );

  if (showArchive) {
    mount(
      h('h1', {}, 'Архів'),
      h('div', { class: 'card' },
        groups.length === 0
          ? h('p', { class: 'empty' }, 'В архіві порожньо. Групу, де всі розрахувалися, можна перенести сюди кнопкою «В архів» на її сторінці.')
          : h('ul', { class: 'list' }, groups.map(groupItem)),
      ),
      groups.length > 0 && h('p', { class: 'sub hint' },
        'Архів бачите лише ви — в інших учасників група лишається як була. Якщо в групі знову з\'являться борги, вона сама повернеться до активних.'),
    );
    return;
  }

  const error = h('div', { class: 'error' });
  const form = h('form', {},
    h('div', { class: 'row' },
      h('input', { name: 'name', placeholder: 'Напр. «Квартира» або «Відпустка 2026»', required: true, maxLength: 100 }),
      h('button', { type: 'submit' }, 'Створити групу'),
    ),
    error,
  );
  form.addEventListener('submit', submitHandler(form, error, async (data) => {
    const groupId = await run(supabase.rpc('create_group', { group_name: data.get('name') }));
    location.hash = `#/groups/${groupId}`;
  }));

  const total = groups.reduce((sum, g) => sum + g.myBalance, 0);

  mount(
    h('h1', {}, 'Мої групи'),
    groups.length > 0 && h('div', { class: 'card' }, h('h2', {}, 'Загальний баланс'), balanceLabel(total)),
    h('div', { class: 'card' },
      groups.length === 0
        ? h('p', { class: 'empty' }, archivedCount > 0 ? 'Активних груп немає. Створіть нову нижче.' : 'У вас ще немає груп. Створіть першу нижче.')
        : h('ul', { class: 'list' }, groups.map(groupItem)),
    ),
    h('div', { class: 'card' }, h('h2', {}, 'Нова група'), form),
  );
}

// ---------- Сторінка групи ----------

async function renderGroup(groupId) {
  const [group, memberRows, expenseRows, settlementRows, categories, history] = await Promise.all([
    run(supabase.from('groups').select('id, name, currency, invite_token, created_by').eq('id', groupId).maybeSingle()),
    run(supabase.from('group_members').select('user_id, archived_at, profiles (id, name, email, avatar_path)').eq('group_id', groupId).order('id')),
    run(supabase.from('expenses')
      .select('id, description, amount, paid_by, date, category_id, receipt_path, expense_shares (user_id, amount)')
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
  ]);
  if (!group) throw new Error('Групу не знайдено');

  const members = memberRows.map((r) => r.profiles);
  // Квитанції лежать у приватному сховищі — даємо тимчасові посилання на годину.
  const receiptPaths = expenseRows.map((e) => e.receipt_path).filter(Boolean);
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
    receiptPath: e.receipt_path,
    receiptUrl: receiptUrls.get(e.receipt_path) ?? null,
    edited: history.some((x) => x.action === 'updated' && x.expense_id === e.id),
    shares: e.expense_shares.map((s) => ({ userId: s.user_id, amount: Number(s.amount) })),
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
    formSlot.replaceChildren(expenseFormCard(groupId, members, categories, reload, editing, () => showExpenseForm()));
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
    analytics: { label: '📊 Аналітика', render: () => analyticsCard(expenses, members, categoryOf) },
    history: { label: '🕘 Історія змін', render: () => historyCard(history, nameOf, categoryOf) },
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
  if (groupUi.groupId !== groupId) Object.assign(groupUi, { groupId, panel: null, period: 'all', inviteOpen: false, openExpenses: new Set() });
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

// Стан сторінки групи, що переживає перемальовування (відкрита панель, період аналітики, блок запрошення).
const groupUi = { groupId: null, panel: null, period: 'all', inviteOpen: false, openExpenses: new Set() };

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
          type: 'button', role: 'menuitem', class: key === active ? 'menu-item active' : 'menu-item',
          onClick: () => {
            setOpen(false);
            onPick(key);
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
    invitePanel(group, form, reload),
  );
}

/** Кнопка «Запросити учасника», що розгортає посилання-запрошення та додавання за email. */
function invitePanel(group, emailForm, reload) {
  const body = h('div', { class: 'invite-body', id: `invite-${group.id}`, hidden: !groupUi.inviteOpen },
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


/**
 * Блок «Квитанція» у формі витрати: сфотографувати / вибрати фото, переглянути, розпізнати позиції.
 * Повертає елемент і стан: нове фото (file), чи прибрали наявне (removed).
 */
function receiptField(existingUrl, amountInput, descriptionInput) {
  const state = { file: null, removed: false };
  let previewUrl = null;

  const pick = (capture) => {
    const input = h('input', { type: 'file', accept: 'image/*', capture, hidden: true });
    input.addEventListener('change', () => {
      const file = input.files[0];
      input.remove();
      if (!file) return;
      state.file = file;
      state.removed = false;
      render();
    });
    document.body.append(input); // деякі браузери не відкривають вибір файлу для від'єднаного input
    input.click();
  };

  const results = h('div', { class: 'receipt-results' });
  const box = h('div', { class: 'receipt' });

  function currentImage() {
    if (state.file) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(state.file);
      return previewUrl;
    }
    return state.removed ? null : existingUrl;
  }

  async function recognize(button) {
    button.disabled = true;
    const status = h('p', { class: 'sub' });
    results.replaceChildren(status);
    try {
      const image = state.file ? await scaledJpeg(state.file, 2000) : existingUrl;
      const text = await recognizeText(image, (msg) => { status.textContent = msg; });
      showItems(parseReceipt(text));
    } catch (err) {
      results.replaceChildren(h('p', { class: 'error' }, err.message));
    } finally {
      button.disabled = false;
    }
  }

  function showItems({ items, total }) {
    if (items.length === 0) {
      results.replaceChildren(h('p', { class: 'sub' },
        total ? `Позицій не знайшов, але підсумок чека — ${formatMoney(total)}. ` : 'Не вдалося знайти позиції з сумами. ',
        'Спробуйте сфотографувати рівніше, ближче й при кращому світлі.'),
      total ? h('button', { type: 'button', class: 'secondary', onClick: () => fill(total, '') }, `Підставити ${formatMoney(total)}`) : '');
      return;
    }
    const checks = items.map(() => h('input', { type: 'checkbox', checked: true }));
    const sumLabel = h('span', { class: 'amount' });
    const fillButton = h('button', { type: 'button' });
    const selected = () => items.filter((_, i) => checks[i].checked);
    const update = () => {
      const sum = selected().reduce((acc, it) => acc + it.amount, 0);
      sumLabel.textContent = formatMoney(sum);
      fillButton.textContent = `Підставити у форму (${formatMoney(sum)})`;
      fillButton.disabled = sum === 0;
    };
    checks.forEach((c) => c.addEventListener('change', update));
    fillButton.addEventListener('click', () => {
      const chosen = selected();
      fill(chosen.reduce((acc, it) => acc + it.amount, 0),
        chosen.length <= 3 ? chosen.map((it) => it.name).join(', ') : `${chosen.slice(0, 2).map((it) => it.name).join(', ')} та ще ${chosen.length - 2}`);
    });
    results.replaceChildren(
      h('p', { class: 'sub' }, 'Знайдені позиції — зніміть галочки з тих, що не входять у спільну витрату. Перевірте суми: розпізнавання може помилятися.'),
      h('ul', { class: 'receipt-items' }, items.map((it, i) =>
        h('li', {}, h('label', {}, checks[i], h('span', {}, it.name)), h('span', { class: 'amount' }, formatMoney(it.amount))))),
      h('div', { class: 'receipt-sum' },
        h('span', {}, 'Вибрано'), sumLabel),
      total !== items.reduce((acc, it) => acc + it.amount, 0) ? h('p', { class: 'sub' }, `Підсумок у чеку: ${formatMoney(total)}`) : '',
      fillButton,
    );
    update();
  }

  function fill(amount, description) {
    amountInput.value = formatInput(amount);
    amountInput.dispatchEvent(new Event('input'));
    if (description && !descriptionInput.value.trim()) descriptionInput.value = description.slice(0, 200);
    toast('Суму підставлено — перевірте форму');
  }

  function render() {
    const src = currentImage();
    results.replaceChildren();
    box.replaceChildren(
      h('div', { class: 'receipt-head' }, h('span', { class: 'sub' }, 'Квитанція (необов\'язково)')),
      src
        ? h('div', { class: 'receipt-preview' },
          h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img', { src, alt: 'Фото квитанції' })),
          h('div', { class: 'receipt-actions' },
            h('button', { type: 'button', onClick: (e) => recognize(e.currentTarget) }, '🔍 Розпізнати суми'),
            h('button', { type: 'button', class: 'secondary', onClick: () => pick('environment') }, '📷 Інше фото'),
            h('button', {
              type: 'button', class: 'secondary',
              onClick: () => {
                state.file = null;
                state.removed = true;
                render();
              },
            }, '✕ Прибрати'),
          ))
        : h('div', { class: 'receipt-actions' },
          h('button', { type: 'button', class: 'secondary', onClick: () => pick('environment') }, '📷 Сфотографувати'),
          h('button', { type: 'button', class: 'secondary', onClick: () => pick(null) }, '🖼 Вибрати фото'),
        ),
      results,
    );
  }
  render();
  return { el: box, state };
}

/** Прикріплює до витрати нове фото квитанції або прибирає наявне; старий файл видаляє. */
async function saveReceipt(groupId, expenseId, state) {
  if (!state.file && !state.removed) return;
  let path = null;
  if (state.file) {
    path = `${groupId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`;
    await run(supabase.storage.from('receipts').upload(path, await scaledJpeg(state.file), { contentType: 'image/jpeg' }));
  }
  const oldPath = await run(supabase.rpc('set_expense_receipt', { expense_id: expenseId, receipt_path: path }));
  if (oldPath) await supabase.storage.from('receipts').remove([oldPath]);
}

/** Форма нової витрати; якщо передано editing — редагування цієї витрати. */
function expenseFormCard(groupId, members, categories, reload, editing = null, onCancel = null) {
  const error = h('div', { class: 'error' });

  // Під час редагування: якщо частки — це рівний поділ між тими, хто бере участь, показуємо «Порівну».
  const shareOf = new Map((editing?.shares ?? []).map((s) => [s.userId, s.amount]));
  const participantIds = members.filter((m) => shareOf.get(m.id) > 0).map((m) => m.id);
  const isEqual = !editing || (participantIds.length > 0 && participantIds.length === shareOf.size
    && splitEqually(editing.amount, participantIds).every((s) => shareOf.get(s.userId) === s.amount));

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
    name: 'amount', required: true, inputMode: 'decimal', placeholder: '0,00', value: editing ? formatInput(editing.amount) : '',
  });
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
      : rest > 0 ? `Залишилось розподілити: ${formatMoney(rest)}`
      : `Частки більші за суму на ${formatMoney(-rest)}`;
  }
  shareInputs.forEach((input, i) => input.addEventListener('input', () => {
    if (input.value.trim()) manual.add(i);
    else manual.delete(i);
    updateShares();
  }));
  amountInput.addEventListener('input', updateShares);

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
  const receipt = receiptField(editing?.receiptUrl ?? null, amountInput, descriptionInput);

  const form = h('form', {},
    receipt.el,
    h('label', {}, 'Опис', descriptionInput),
    h('div', { class: 'row' },
      h('label', {}, 'Сума, ₴', amountInput),
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
    const amount = parseMoney(data.get('amount'));
    if (!amount) throw new Error('Вкажіть коректну суму, напр. 150 або 99,90');

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
      if (total !== amount) {
        throw new Error(`Сума часток (${formatMoney(total)}) не дорівнює сумі витрати (${formatMoney(amount)})`);
      }
    }

    const fields = {
      description: String(data.get('description')).trim(),
      amount,
      paid_by: String(data.get('paidBy')),
      shares: shares.map((s) => ({ user_id: s.userId, amount: s.amount })),
      expense_date: data.get('date') || today(),
      category_id: data.get('category') ? Number(data.get('category')) : null,
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
      h('label', {}, 'Сума, ₴', h('input', { name: 'amount', required: true, inputMode: 'decimal', placeholder: '0,00' })),
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

function expensesCard(groupId, expenses, profileOf, reload, onEdit) {
  const expenseItem = (e) => {
    // Рівний поділ: частки відрізняються щонайбільше на копійку (залишок від ділення).
    const amounts = e.shares.map((s) => s.amount);
    const isEqual = amounts.length > 0 && Math.max(...amounts) - Math.min(...amounts) <= 1;
    const details = h('details', { class: 'expense', open: groupUi.openExpenses.has(e.id) },
      h('summary', {},
        h('div', { class: 'expense-main' },
          h('div', { class: 'expense-title' }, e.description,
            e.category ? h('span', { class: 'tag' }, categoryLabel(e.category)) : null),
          h('div', { class: 'sub' }, formatDate(e.date)),
        ),
        h('span', { class: 'amount' }, formatMoney(e.amount)),
        h('span', { class: 'chevron', 'aria-hidden': 'true' }, '›'),
      ),
      h('div', { class: 'expense-body' },
        h('div', { class: 'field' },
          h('span', { class: 'field-label' }, 'Хто платив'),
          h('div', { class: 'pills' }, personPill(profileOf(e.paidBy))),
        ),
        h('div', { class: 'field' },
          h('span', { class: 'field-label' }, isEqual ? 'Ділили порівну' : 'Ділили точними сумами'),
          h('div', { class: 'pills' }, e.shares.map((s) => personPill(profileOf(s.userId), s.amount))),
        ),
        h('div', { class: 'expense-actions' },
          e.edited ? h('span', { class: 'sub' }, 'змінено') : null,
          e.receiptUrl && h('a', { class: 'receipt-link', href: e.receiptUrl, target: '_blank', rel: 'noopener', title: 'Фото квитанції' }, '🧾'),
          h('button', { class: 'link edit', title: 'Редагувати витрату', onClick: () => onEdit(e) }, '✎ Редагувати'),
          h('button', {
            class: 'link',
            title: 'Видалити витрату',
            onClick: async () => {
              if (!confirm(`Видалити витрату «${e.description}»?`)) return;
              try {
                await run(supabase.from('expenses').delete().eq('id', e.id));
                if (e.receiptPath) await supabase.storage.from('receipts').remove([e.receiptPath]);
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

  return h('div', { class: 'card' },
    h('h2', {}, 'Витрати'),
    expenses.length === 0
      ? h('p', { class: 'empty' }, 'Витрат ще немає.')
      : h('ul', { class: 'list expenses' }, expenses.map(expenseItem)),
  );
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
  // Після переходу за посиланням з листа Supabase повертає токен у #…; getSession() його обробляє.
  await supabase.auth.getSession();
  if (/access_token|error_description/.test(location.hash)) {
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.get('error_description')) toast(params.get('error_description'));
    history.replaceState(null, '', `${location.pathname}#/`);
  }
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      currentUser = null;
      renderUserbox();
      renderTabbar('');
    }
  });
  window.addEventListener('hashchange', route);
  route();
}

start();
