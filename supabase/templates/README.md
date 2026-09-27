# Шаблони листів (Supabase Auth)

Вставляються вручну: Supabase → **Authentication → Emails → Templates**.
Для кожного шаблону скопіюйте **Subject** з таблиці, а **Message body** — увесь вміст відповідного файлу. Потім **Save**.

| Шаблон у Supabase | Файл | Subject |
|---|---|---|
| Confirm signup | [`confirm-signup.html`](confirm-signup.html) | Підтвердіть реєстрацію у «Спільні витрати» |
| Invite user | [`invite.html`](invite.html) | Вас запрошено до «Спільні витрати» |
| Magic link | [`magic-link.html`](magic-link.html) | Вхід у «Спільні витрати» |
| Change email address | [`change-email.html`](change-email.html) | Підтвердіть нову пошту у «Спільні витрати» |
| Reset password | [`reset-password.html`](reset-password.html) | Відновлення пароля у «Спільні витрати» |

Кнопки в листах ведуть на сам сайт (`{{ .SiteURL }}/?token_hash=…&type=…`), а не на `*.supabase.co`:
застосунок сам підтверджує посилання (`verifyOtp`). Тому **Site URL** в Supabase має бути адресою сайту
(зараз `https://finance.chinnect24.com`).
