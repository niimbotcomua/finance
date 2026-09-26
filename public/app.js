// Клієнтська частина: невеликий SPA без фреймворків.
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

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') {
    currentUser = null;
    renderUserbox();
    if (!location.hash.startsWith('#/login')) location.hash = '#/login';
  }
  if (!res.ok) throw new Error(data.error || `Помилка ${res.status}`);
  return data;
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
        await api('POST', '/auth/logout', {});
        currentUser = null;
        renderUserbox();
        location.hash = '#/login';
      },
    }, 'Вийти'),
  );
}

// ---------- Вхід / реєстрація ----------

function renderAuth() {
  let mode = 'login';
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
    const payload = Object.fromEntries(data);
    const { user } = await api('POST', mode === 'login' ? '/auth/login' : '/auth/register', payload);
    currentUser = user;
    renderUserbox();
    location.hash = '#/';
  }));

  setMode('login');
  mount(
    h('div', { class: 'card auth' },
      h('h1', {}, 'Ласкаво просимо'),
      h('p', { class: 'sub' }, 'Ведіть спільні витрати з друзями, сусідами чи колегами та дізнавайтеся, хто кому скільки винен.'),
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
  const { groups } = await api('GET', '/groups');
  const error = h('div', { class: 'error' });
  const form = h('form', {},
    h('div', { class: 'row' },
      h('input', { name: 'name', placeholder: 'Напр. «Квартира» або «Відпустка 2026»', required: true, maxLength: 100 }),
      h('button', { type: 'submit' }, 'Створити групу'),
    ),
    error,
  );
  form.addEventListener('submit', submitHandler(form, error, async (data) => {
    const { group } = await api('POST', '/groups', { name: data.get('name') });
    location.hash = `#/groups/${group.id}`;
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
  const data = await api('GET', `/groups/${groupId}`);
  const { group, members, expenses, settlements, balances, suggestedTransfers } = data;
  const nameOf = (id) => members.find((m) => m.id === id)?.name ?? '—';
  const reload = () => renderGroup(groupId);

  mount(
    h('p', {}, h('a', { href: '#/' }, '← Усі групи')),
    h('h1', {}, group.name),
    h('div', { class: 'grid' },
      h('div', {},
        balancesCard(balances, nameOf),
        transfersCard(groupId, suggestedTransfers, nameOf, reload),
        membersCard(groupId, members, balances, reload),
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
                  await api('POST', `/groups/${groupId}/settlements`, { fromUser: t.from, toUser: t.to, amount: t.amount });
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

function membersCard(groupId, members, balances, reload) {
  const error = h('div', { class: 'error' });
  const form = h('form', {},
    h('div', { class: 'row' },
      h('input', { name: 'email', type: 'email', placeholder: 'email учасника', required: true }),
      h('button', { type: 'submit' }, 'Додати'),
    ),
    error,
  );
  form.addEventListener('submit', submitHandler(form, error, async (data) => {
    const { member } = await api('POST', `/groups/${groupId}/members`, { email: data.get('email') });
    toast(`${member.name} тепер у групі`);
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
                  await api('DELETE', `/groups/${groupId}/members/${m.id}`);
                  reload();
                } catch (err) {
                  toast(err.message);
                }
              },
            }, '✕'),
        ),
      ),
    ),
    form,
    h('p', { class: 'sub' }, 'Учасник має бути зареєстрований у застосунку.'),
  );
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

    let split;
    if (data.get('splitType') === 'equal') {
      const participants = data.getAll('participant').map(Number);
      if (participants.length === 0) throw new Error('Оберіть хоча б одного учасника');
      split = { type: 'equal', participants };
    } else {
      const shares = [];
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
      split = { type: 'exact', shares };
    }

    await api('POST', `/groups/${groupId}/expenses`, {
      description: data.get('description'),
      amount,
      paidBy: Number(data.get('paidBy')),
      date: data.get('date') || undefined,
      split,
    });
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
    await api('POST', `/groups/${groupId}/settlements`, {
      fromUser: Number(data.get('fromUser')),
      toUser: Number(data.get('toUser')),
      amount,
      date: data.get('date') || undefined,
    });
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
                  await api('DELETE', `/groups/${groupId}/expenses/${e.id}`).catch((err) => toast(err.message));
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
                await api('DELETE', `/groups/${groupId}/settlements/${s.id}`).catch((err) => toast(err.message));
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
    if (!currentUser && hash !== '#/login') {
      try {
        currentUser = (await api('GET', '/me')).user;
        renderUserbox();
      } catch {
        return; // api() уже перенаправив на #/login
      }
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

window.addEventListener('hashchange', route);
route();
