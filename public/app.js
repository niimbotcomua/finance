// Клієнтська частина: невеликий SPA без фреймворків; дані зберігаються в Supabase.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { computeBalances, simplifyDebts, splitEqually } from './balances.js';

const configured = SUPABASE_URL.startsWith('https://') && !SUPABASE_ANON_KEY.includes('ВСТАВТЕ');
const supabase = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const app = document.getElementById('app');
const userbox = document.getElementById('userbox');
const toastEl = document.getElementById('toast');

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
  const profile = await run(supabase.from('profiles').select('id, name, email').eq('id', session.user.id).maybeSingle());
  return profile ?? { id: session.user.id, email: session.user.email, name: session.user.email };
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
    h('span', {}, currentUser.name),
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

async function renderGroups() {
  const groups = (await run(supabase.rpc('my_groups'))).map((g) => ({
    id: g.id,
    name: g.name,
    memberCount: Number(g.member_count),
    myBalance: Number(g.my_balance),
  }));
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
        ? h('p', { class: 'empty' }, 'У вас ще немає груп. Створіть першу нижче.')
        : h('ul', { class: 'list' },
          groups.map((g) =>
            h('li', {},
              h('div', {},
                h('a', { href: `#/groups/${g.id}` }, g.name),
                h('div', { class: 'sub' }, `${g.memberCount} учасн.`),
              ),
              balanceLabel(g.myBalance),
            ),
          ),
        ),
    ),
    h('div', { class: 'card' }, h('h2', {}, 'Нова група'), form),
  );
}

// ---------- Сторінка групи ----------

async function renderGroup(groupId) {
  const [group, memberRows, expenseRows, settlementRows] = await Promise.all([
    run(supabase.from('groups').select('id, name, currency, invite_token').eq('id', groupId).maybeSingle()),
    run(supabase.from('group_members').select('profiles (id, name, email)').eq('group_id', groupId).order('id')),
    run(supabase.from('expenses')
      .select('id, description, amount, paid_by, date, expense_shares (user_id, amount)')
      .eq('group_id', groupId)
      .order('date', { ascending: false })
      .order('id', { ascending: false })),
    run(supabase.from('settlements')
      .select('id, from_user, to_user, amount, date')
      .eq('group_id', groupId)
      .order('date', { ascending: false })
      .order('id', { ascending: false })),
  ]);
  if (!group) throw new Error('Групу не знайдено');

  const members = memberRows.map((r) => r.profiles);
  const expenses = expenseRows.map((e) => ({
    id: e.id,
    description: e.description,
    amount: Number(e.amount),
    paidBy: e.paid_by,
    date: e.date,
    shares: e.expense_shares.map((s) => ({ userId: s.user_id, amount: Number(s.amount) })),
  }));
  const settlements = settlementRows.map((s) => ({
    id: s.id, fromUser: s.from_user, toUser: s.to_user, amount: Number(s.amount), date: s.date,
  }));
  const balanceMap = computeBalances(members.map((m) => m.id), expenses, settlements);
  const balances = [...balanceMap].map(([userId, balance]) => ({ userId, balance }));
  const suggestedTransfers = simplifyDebts(balanceMap);
  const nameOf = (id) => members.find((m) => m.id === id)?.name ?? '—';
  const reload = () => renderGroup(groupId);

  mount(
    h('p', {}, h('a', { href: '#/' }, '← Усі групи')),
    h('h1', {}, group.name),
    h('div', { class: 'grid' },
      h('div', {},
        balancesCard(balances, nameOf),
        transfersCard(groupId, suggestedTransfers, nameOf, reload),
        membersCard(group, members, reload),
      ),
      h('div', {},
        expenseFormCard(groupId, members, reload),
        settlementFormCard(groupId, members, reload),
      ),
    ),
    expensesCard(groupId, expenses, nameOf, reload),
    settlementsCard(groupId, settlements, nameOf, reload),
  );
}

function balancesCard(balances, nameOf) {
  return h('div', { class: 'card' },
    h('h2', {}, 'Баланси'),
    h('ul', { class: 'list' },
      balances.map(({ userId, balance }) =>
        h('li', {},
          h('span', {}, nameOf(userId), userId === currentUser.id ? ' (ви)' : ''),
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
        h('li', {},
          h('div', {}, m.name, h('div', { class: 'sub' }, m.email)),
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
    inviteBlock(group, reload),
    h('p', { class: 'sub' }, 'Або додайте за email, якщо людина вже зареєстрована:'),
    form,
  );
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


function expenseFormCard(groupId, members, reload) {
  const error = h('div', { class: 'error' });
  const splitType = h('select', { name: 'splitType' },
    h('option', { value: 'equal' }, 'Порівну'),
    h('option', { value: 'exact' }, 'Точними сумами'),
  );
  const equalBox = h('div', { class: 'checks' },
    members.map((m) =>
      h('label', {}, h('input', { type: 'checkbox', name: 'participant', value: String(m.id), checked: true }), m.name),
    ),
  );
  const exactBox = h('div', { class: 'shares', hidden: true },
    members.map((m) =>
      h('label', {}, m.name, h('input', { name: `share-${m.id}`, inputMode: 'decimal', placeholder: '0,00' })),
    ),
  );
  splitType.addEventListener('change', () => {
    equalBox.hidden = splitType.value !== 'equal';
    exactBox.hidden = splitType.value !== 'exact';
  });

  const form = h('form', {},
    h('label', {}, 'Опис', h('input', { name: 'description', required: true, maxLength: 200, placeholder: 'Напр. «Продукти»' })),
    h('div', { class: 'row' },
      h('label', {}, 'Сума, ₴', h('input', { name: 'amount', required: true, inputMode: 'decimal', placeholder: '0,00' })),
      h('label', {}, 'Дата', h('input', { name: 'date', type: 'date', value: today() })),
    ),
    h('div', { class: 'row' },
      h('label', {}, 'Хто платив',
        h('select', { name: 'paidBy' },
          members.map((m) => h('option', { value: String(m.id), selected: m.id === currentUser.id }, m.name)),
        ),
      ),
      h('label', {}, 'Як ділити', splitType),
    ),
    equalBox,
    exactBox,
    error,
    h('button', { type: 'submit' }, 'Додати витрату'),
  );

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

    await run(supabase.rpc('add_expense', {
      gid: groupId,
      description: String(data.get('description')).trim(),
      amount,
      paid_by: String(data.get('paidBy')),
      shares: shares.map((s) => ({ user_id: s.userId, amount: s.amount })),
      expense_date: data.get('date') || today(),
    }));
    toast('Витрату додано');
    reload();
  }));

  return h('div', { class: 'card' }, h('h2', {}, 'Нова витрата'), form);
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

function expensesCard(groupId, expenses, nameOf, reload) {
  return h('div', { class: 'card' },
    h('h2', {}, 'Витрати'),
    expenses.length === 0
      ? h('p', { class: 'empty' }, 'Витрат ще немає.')
      : h('ul', { class: 'list' },
        expenses.map((e) => {
          const shareText = e.shares.map((s) => `${nameOf(s.userId)} ${formatMoney(s.amount)}`).join(', ');
          return h('li', {},
            h('div', {},
              h('div', {}, e.description),
              h('div', { class: 'sub' }, `${formatDate(e.date)} · платив(ла) ${nameOf(e.paidBy)} · ${shareText}`),
            ),
            h('div', { class: 'actions' },
              h('span', { class: 'amount' }, formatMoney(e.amount)),
              h('button', {
                class: 'link',
                title: 'Видалити витрату',
                onClick: async () => {
                  if (!confirm(`Видалити витрату «${e.description}»?`)) return;
                  await run(supabase.from('expenses').delete().eq('id', e.id)).catch((err) => toast(err.message));
                  reload();
                },
              }, '✕'),
            ),
          );
        }),
      ),
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
    if (groupMatch) await renderGroup(Number(groupMatch[1]));
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
    }
  });
  window.addEventListener('hashchange', route);
  route();
}

start();
