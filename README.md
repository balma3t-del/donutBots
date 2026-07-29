# McBotPanel

TypeScript-панель для управления mineflayer-ботами через Telegram (только inline-клавиатура).

## Возможности

- Классовая сессия `BotSession` (как в MineCraftBot / UndeadShop)
- Вход с **лицензией** (`auth: 'microsoft'`)
- Стабильный онлайн: keepAlive + авто-реконнект
- Без капчи и без `/login` — сразу в игру после коннекта
- Отправка сообщений/команд в MC-чат из Telegram (чат сервера в TG не транслируется)
- SOCKS5 прокси (опционально)

## Запуск через Docker (рекомендуется)

```bash
# .env уже должен быть заполнен (BOT_TOKEN, ADMIN_IDS, MC_*)
docker compose up -d --build
docker compose logs -f bot
```

Или через npm-скрипты:

```bash
npm run docker:up
npm run docker:logs
```

Данные (SQLite + Microsoft-токены) лежат в `./data` на хосте.

## Локально (без Docker)

Нужен Node 22 (не 24) — иначе `better-sqlite3` часто ломается.

```bash
cp .env.example .env
npm install
npm run dev
```

## Панель

`/start` → Мои боты / Добавить бота

У бота: включить/выключить, настройки (email, пароль, прокси, реконнект), «Отправить в чат».
