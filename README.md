# Спільні витрати

Веб-застосунок для ведення спільних витрат між користувачами (на кшталт Splitwise):
створюйте групи, додавайте витрати й одразу бачте, хто кому скільки винен.

**Стек:** статичний фронтенд (HTML/CSS/JS без фреймворків) на **Vercel** + **Supabase**
(Postgres, автентифікація, Row Level Security). Окремого сервера немає.

## Можливості

- Реєстрація та вхід через Supabase Auth (email + пароль, підтвердження пошти).
- Групи; запрошення за **посиланням** (людина реєструється й одразу потрапляє в групу)
  або додавання вже зареєстрованих учасників за email.
- Витрати: хто платив, дата, **тег** (категорія), розподіл **порівну** або **точними сумами**
  (залишок автоматично підставляється останньому незаповненому учаснику).
- Профіль: ім'я та **фото** (зберігається в Supabase Storage, кошик `avatars`).
- Назву групи може змінити її автор.
- **Адмінка** (`#/admin`) для супер-адміна: спільні для всіх теги витрат і список усіх користувачів.
  Першого адміна призначають у SQL Editor:
  `insert into private.admins (user_id) select id from public.profiles where email = 'ваш@email';`
- Баланси учасників і **спрощення боргів** — мінімальний набір переказів «хто → кому».
- Запис повернення боргу (кнопка «Сплачено» або вручну), скасування переказів, видалення витрат.
- Суми зберігаються в копійках (цілі числа) — без похибок округлення.
- Кожен бачить лише свої групи: доступ перевіряє сама база (RLS).

## Розгортання

### 1. Supabase

1. Створіть проєкт на [supabase.com](https://supabase.com) (регіон — Central EU, Frankfurt).
2. **SQL Editor → New query** → по черзі виконайте файли з [`supabase/migrations/`](supabase/migrations)
   (`001_…`, `002_…`, …): вставте вміст → **Run**. Кожен файл можна виконувати повторно.
3. **Authentication → URL Configuration → Site URL**: вкажіть адресу сайту на Vercel
   (напр. `https://finance-xxx.vercel.app`), щоб посилання з листів вели на ваш сайт.
4. **Project Settings → API**: скопіюйте *Project URL* та *anon public key* у
   [`public/config.js`](public/config.js). Ключ `service_role` / `secret` туди **не** вставляйте.

За бажання підтвердження email можна вимкнути: **Authentication → Sign In / Providers → Email → Confirm email**.

### 2. Vercel

1. [vercel.com](https://vercel.com) → **Add New… → Project** → імпортуйте цей репозиторій.
2. Налаштування вже задані у [`vercel.json`](vercel.json) (без збірки, сайт — папка `public/`). Натисніть **Deploy**.
3. Кожен `git push` автоматично оновлює сайт.

## Локальна розробка

```bash
npm install
npm run dev     # http://localhost:3000 (використовує Supabase з public/config.js)
npm test        # тести логіки та SQL-схеми (Postgres у WASM через PGlite)
```

## Структура

```
public/index.html    сторінка
public/app.js        інтерфейс і робота з Supabase
public/balances.js   розподіл сум, баланси, спрощення боргів
public/config.js     адреса та публічний ключ Supabase
supabase/migrations/ таблиці, правила доступу (RLS) і функції бази (по черзі)
test/                тести (node:test)
vercel.json          налаштування Vercel
```
