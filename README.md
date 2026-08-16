# FunTime McBotPanel (только пиратка / offline)

TypeScript-панель для mineflayer-ботов на **FunTime** (`mc.funtime.su`) через Telegram inline-клавиатуру.

## Отличия от Donut-версии

- Вход **только пираткой** (`auth: 'offline'`) — без Microsoft / лицензии
- Ник + пароль FunTime (`/login` / `/reg` автоматически)
- Капча через FlayerCaptcha + CapMonster (если задан `CAPMONSTER_API_KEY`)
- Хост по умолчанию: `mc.funtime.su:25565`

## Запуск через Docker

```bash
cp .env.example .env
# заполни BOT_TOKEN, ADMIN_IDS, CAPMONSTER_API_KEY
docker compose up -d --build
docker compose logs -f bot
```

## Локально

Нужен Node 22.

```bash
cp .env.example .env
npm install
npm run dev
```

## Панель

`/start` → Мои боты / Добавить бота

Добавление: ник пиратки → пароль FunTime → прокси (или `-`).

У бота: вкл/выкл, чат, игроки рядом, кликер ПКМ, настройки.
