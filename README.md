# Спільні витрати

Веб-застосунок для ведення спільних витрат між користувачами (на кшталт Splitwise):
створюйте групи, додавайте витрати й одразу бачте, хто кому скільки винен.

## Можливості

- Реєстрація та вхід (паролі — scrypt, сесії в HttpOnly-cookie).
- Групи: «Квартира», «Відпустка», «Офіс» тощо; додавання учасників за email.
- Витрати: хто платив, дата, розподіл **порівну** між обраними учасниками або **точними сумами**.
- Баланси кожного учасника та **спрощення боргів** — мінімальний набір переказів «хто → кому».
- Запис повернення боргу (кнопка «Сплачено» або вручну), скасування переказів і видалення витрат.
- Усі суми зберігаються в копійках (цілі числа) — без похибок округлення.

## Запуск

Потрібен Node.js ≥ 22.13 (використовується вбудований `node:sqlite`).

```bash
npm install
npm start          # http://localhost:3000
npm test           # тести
```

Змінні середовища:

| Змінна        | За замовчуванням     | Опис                                          |
|---------------|----------------------|-----------------------------------------------|
| `PORT`        | `3000`               | Порт HTTP-сервера                             |
| `DB_PATH`     | `./data/finance.db`  | Шлях до файлу бази SQLite                     |
| `TRUST_PROXY` | —                    | `1`, якщо застосунок за reverse proxy (HTTPS) |

## Структура

```
server.js            точка входу
src/app.js           Express-застосунок і REST API
src/db.js            схема SQLite
src/auth.js          паролі, сесії, cookie
src/balances.js      розподіл сум, баланси, спрощення боргів
public/              клієнт (HTML/CSS/JS без фреймворків)
test/                тести (node:test)
```

## API (коротко)

Суми в запитах і відповідях — цілі числа в копійках.

| Метод  | Шлях                                        | Опис                                           |
|--------|---------------------------------------------|------------------------------------------------|
| POST   | `/api/auth/register`, `/api/auth/login`     | `{ email, password, name? }`                   |
| POST   | `/api/auth/logout`                          |                                                |
| GET    | `/api/me`                                   | Поточний користувач                            |
| GET    | `/api/groups`                               | Мої групи з моїм балансом                      |
| POST   | `/api/groups`                               | `{ name }`                                     |
| GET    | `/api/groups/:id`                           | Учасники, витрати, баланси, перекази           |
| POST   | `/api/groups/:id/members`                   | `{ email }`                                    |
| DELETE | `/api/groups/:id/members/:userId`           | Лише для учасника без історії в групі          |
| POST   | `/api/groups/:id/expenses`                  | `{ description, amount, paidBy, date, split }` |
| DELETE | `/api/groups/:id/expenses/:expenseId`       |                                                |
| POST   | `/api/groups/:id/settlements`               | `{ fromUser, toUser, amount, date }`           |
| DELETE | `/api/groups/:id/settlements/:settlementId` |                                                |

`split` — `{ "type": "equal", "participants": [1, 2] }` або
`{ "type": "exact", "shares": [{ "userId": 1, "amount": 5000 }] }`.
