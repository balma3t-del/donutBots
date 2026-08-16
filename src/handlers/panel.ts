import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../bot.js';
import { clearAwait, mainMenuKeyboard } from '../bot.js';
import { isAdmin, MC_HOST, MC_PORT } from '../config.js';
import { db } from '../database/db.js';
import type { SessionManager } from '../minecraft/SessionManager.js';
import { formatProxy, parseProxy } from '../utils/proxy.js';
import type { BotRecord } from './types.js';

function statusEmoji(status: string): string {
  if (status === 'online') return '🟢';
  if (status === 'connecting') return '🟡';
  return '🔴';
}

function botTitle(bot: BotRecord, manager: SessionManager): string {
  const session = manager.getSession(bot.id);
  const name = session?.inGameName || bot.label || bot.email || `#${bot.id}`;
  return `${statusEmoji(manager.getStatus(bot.id))} ${name}`;
}

function botsListKeyboard(manager: SessionManager): InlineKeyboard {
  const kb = new InlineKeyboard();
  const bots = db.listBots();
  if (bots.length === 0) {
    kb.text('Добавить бота', 'bots:add').row();
  } else {
    for (const bot of bots) {
      kb.text(botTitle(bot, manager), `bot:${bot.id}`).row();
    }
    kb.text('➕ Добавить', 'bots:add').row();
  }
  kb.text('« Меню', 'menu:main');
  return kb;
}

function botCardText(bot: BotRecord, manager: SessionManager): string {
  const status = manager.getStatus(bot.id);
  const session = manager.getSession(bot.id);
  const lines = [
    `<b>${botTitle(bot, manager)}</b>`,
    `ID: <code>${bot.id}</code>`,
    `Сервер: <code>${MC_HOST}:${MC_PORT}</code> (пиратка)`,
    `Статус: <b>${status}</b>`,
    `Ник: <code>${bot.email || '—'}</code>`,
    `Пароль /login: ${bot.password ? 'задан' : 'не задан'}`,
    `Прокси: <code>${formatProxy({
      host: bot.proxyHost,
      port: bot.proxyPort,
      user: bot.proxyUser,
      pass: bot.proxyPass,
    })}</code>`,
    `Автореконнект: ${bot.reconnect ? 'вкл' : 'выкл'}`,
    `Кликер ПКМ: ${session?.isClickerOn ? 'вкл' : 'выкл'} · ${session?.clickerCps ?? bot.clickerCps} CPS`,
  ];
  if (session?.inGameName) lines.splice(4, 0, `В игре: <b>${session.inGameName}</b>`);
  return lines.join('\n');
}

function botActionsKeyboard(bot: BotRecord, manager: SessionManager): InlineKeyboard {
  const status = manager.getStatus(bot.id);
  const powerText =
    status === 'online' ? 'Выключить' : status === 'connecting' ? 'Подключается...' : 'Включить';

  const kb = new InlineKeyboard();
  if (status === 'connecting') {
    kb.text('Отменить подключение', `bot:${bot.id}:off`)
      .text('Обновить', `bot:${bot.id}:refresh`);
  } else {
    kb.text(powerText, status === 'online' ? `bot:${bot.id}:off` : `bot:${bot.id}:on`);
  }
  kb.row()
    .text('Отправить в чат', `bot:${bot.id}:chat`)
    .text('Игроки рядом', `bot:${bot.id}:nearby`)
    .row();

  if (status === 'online') {
    kb.text('/dm + окно', `bot:${bot.id}:dm`).row();
    const clickerOn = manager.isClickerOn(bot.id);
    kb.text(clickerOn ? 'Выкл кликер ПКМ' : 'Вкл кликер ПКМ', `bot:${bot.id}:clicker`)
      .row();
  }

  kb.text('Настройки', `bot:${bot.id}:settings`)
    .row()
    .text('Обновить', `bot:${bot.id}:refresh`)
    .text('« К списку', 'bots:list');
  return kb;
}

function settingsKeyboard(bot: BotRecord): InlineKeyboard {
  return new InlineKeyboard()
    .text(bot.email ? 'Ник ✓' : 'Ник ✗', `bot:${bot.id}:set:nick`)
    .text(bot.password ? 'Пароль ✓' : 'Пароль ✗', `bot:${bot.id}:set:password`)
    .row()
    .text(bot.proxyHost ? 'Прокси ✓' : 'Прокси ✗', `bot:${bot.id}:set:proxy`)
    .text(bot.reconnect ? 'Реконнект: вкл' : 'Реконнект: выкл', `bot:${bot.id}:toggle:reconnect`)
    .row()
    .text(`Кликер CPS: ${bot.clickerCps}`, `bot:${bot.id}:clicker:cps`)
    .row()
    .text('🗑 Удалить', `bot:${bot.id}:delete`)
    .row()
    .text('« Назад', `bot:${bot.id}`);
}

function clickerCpsKeyboard(botId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('1', `bot:${botId}:clicker:cps:1`)
    .text('5', `bot:${botId}:clicker:cps:5`)
    .text('8', `bot:${botId}:clicker:cps:8`)
    .text('10', `bot:${botId}:clicker:cps:10`)
    .row()
    .text('12', `bot:${botId}:clicker:cps:12`)
    .text('15', `bot:${botId}:clicker:cps:15`)
    .text('18', `bot:${botId}:clicker:cps:18`)
    .text('20', `bot:${botId}:clicker:cps:20`)
    .row()
    .text('Своё число', `bot:${botId}:clicker:cps:custom`)
    .row()
    .text('« Назад', `bot:${botId}:settings`);
}

async function editOrReply(ctx: BotContext, text: string, keyboard: InlineKeyboard) {
  const opts = { parse_mode: 'HTML' as const, reply_markup: keyboard };
  if (ctx.callbackQuery?.message && 'message_id' in ctx.callbackQuery.message) {
    try {
      await ctx.editMessageText(text, opts);
      return;
    } catch {
      // fallback
    }
  }
  await ctx.reply(text, opts);
}

function ensureAdmin(ctx: BotContext): boolean {
  const id = ctx.from?.id;
  return Boolean(id && isAdmin(id));
}

function isValidNick(nick: string): boolean {
  return /^[A-Za-z0-9_]{3,16}$/.test(nick);
}

export function registerPanel(bot: import('grammy').Bot<BotContext>, manager: SessionManager) {
  bot.command('start', async (ctx) => {
    if (!ensureAdmin(ctx)) {
      await ctx.reply('Нет доступа.');
      return;
    }
    clearAwait(ctx);
    await ctx.reply(`FunTime панель (только пиратка)\n<code>${MC_HOST}:${MC_PORT}</code>`, {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(),
    });
  });

  bot.command('cancel', async (ctx) => {
    if (!ensureAdmin(ctx)) return;
    clearAwait(ctx);
    await ctx.reply('Отменено.', { reply_markup: mainMenuKeyboard() });
  });

  bot.callbackQuery('menu:main', async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    clearAwait(ctx);
    await ctx.answerCallbackQuery();
    await editOrReply(
      ctx,
      `FunTime панель (только пиратка)\n<code>${MC_HOST}:${MC_PORT}</code>`,
      mainMenuKeyboard(),
    );
  });

  bot.callbackQuery('bots:list', async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    clearAwait(ctx);
    await ctx.answerCallbackQuery();
    const bots = db.listBots();
    const text = bots.length
      ? 'Выбери бота:'
      : 'Ботов пока нет. Добавь первого.';
    await editOrReply(ctx, text, botsListKeyboard(manager));
  });

  bot.callbackQuery('bots:add', async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    clearAwait(ctx);
    ctx.session.awaitKind = 'add_nick';
    await ctx.answerCallbackQuery();
    await editOrReply(
      ctx,
      'Введи ник пиратки (3–16: латиница, цифры, _).\nБез лицензии Microsoft.\n/cancel — отмена',
      new InlineKeyboard().text('« Отмена', 'bots:list'),
    );
  });

  bot.callbackQuery(/^bot:(\d+)$/, async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    clearAwait(ctx);
    const id = Number(ctx.match![1]);
    const record = db.getBot(id);
    if (!record) {
      await ctx.answerCallbackQuery({ text: 'Бот не найден' });
      return;
    }
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, botCardText(record, manager), botActionsKeyboard(record, manager));
  });

  bot.callbackQuery(/^bot:(\d+):refresh$/, async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    const id = Number(ctx.match![1]);
    const record = db.getBot(id);
    if (!record) return ctx.answerCallbackQuery({ text: 'Не найден' });
    await ctx.answerCallbackQuery({ text: 'Обновлено' });
    await editOrReply(ctx, botCardText(record, manager), botActionsKeyboard(record, manager));
  });

  bot.callbackQuery(/^bot:(\d+):on$/, async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    const id = Number(ctx.match![1]);
    const result = await manager.turnOn(id);
    const map = {
      ok: 'Включаю...',
      already: 'Уже онлайн/подключается',
      missing: 'Бот не найден',
      no_nick: 'Сначала задай ник',
    } as const;
    await ctx.answerCallbackQuery({ text: map[result] });
    const record = db.getBot(id);
    if (record) {
      await editOrReply(ctx, botCardText(record, manager), botActionsKeyboard(record, manager));
    }
  });

  bot.callbackQuery(/^bot:(\d+):off$/, async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    const id = Number(ctx.match![1]);
    const ok = manager.turnOff(id);
    await ctx.answerCallbackQuery({ text: ok ? 'Выключен' : 'Уже оффлайн' });
    const record = db.getBot(id);
    if (record) {
      await editOrReply(ctx, botCardText(record, manager), botActionsKeyboard(record, manager));
    }
  });

  bot.callbackQuery(/^bot:(\d+):chat$/, async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    const id = Number(ctx.match![1]);
    if (manager.getStatus(id) !== 'online') {
      await ctx.answerCallbackQuery({ text: 'Бот оффлайн' });
      return;
    }
    clearAwait(ctx);
    ctx.session.awaitKind = 'send_chat';
    ctx.session.awaitBotId = id;
    await ctx.answerCallbackQuery();
    await editOrReply(
      ctx,
      `Введи сообщение для чата Minecraft.\nМожно с / в начале (команда).\n/cancel — отмена`,
      new InlineKeyboard().text('« Назад', `bot:${id}`),
    );
  });

  bot.callbackQuery(/^bot:(\d+):nearby$/, async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    const id = Number(ctx.match![1]);
    const result = manager.getNearbyPlayers(id);
    if (result.offline) {
      await ctx.answerCallbackQuery({ text: 'Бот оффлайн' });
      return;
    }
    await ctx.answerCallbackQuery({ text: `Найдено: ${result.count}` });
    await editOrReply(
      ctx,
      result.text,
      new InlineKeyboard()
        .text('Обновить список', `bot:${id}:nearby`)
        .row()
        .text('« Назад', `bot:${id}`),
    );
  });

  bot.callbackQuery(/^bot:(\d+):dm$/, async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    const id = Number(ctx.match![1]);
    if (manager.getStatus(id) !== 'online') {
      await ctx.answerCallbackQuery({ text: 'Бот оффлайн' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Пишу /dm...' });
    void ctx.reply(`📨 [#${id}] Пишу <code>/dm</code>, жду окно...`, { parse_mode: 'HTML' });
    const result = await manager.runDm(id);
    const map = {
      ok: 'Окно пришло в чат',
      offline: 'Бот оффлайн',
      timeout: 'Окно не открылось',
      fail: 'Ошибка',
    } as const;
    const record = db.getBot(id);
    if (record) {
      await editOrReply(
        ctx,
        `${botCardText(record, manager)}\n\n/dm: <b>${map[result]}</b>`,
        botActionsKeyboard(record, manager),
      );
    }
  });

  bot.callbackQuery(/^bot:(\d+):clicker$/, async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    const id = Number(ctx.match![1]);
    if (manager.getStatus(id) !== 'online') {
      await ctx.answerCallbackQuery({ text: 'Бот оффлайн' });
      return;
    }

    if (manager.isClickerOn(id)) {
      const result = manager.stopClicker(id);
      const map = {
        ok: 'Кликер выкл',
        offline: 'Бот оффлайн',
        not_running: 'Кликер уже выкл',
        fail: 'Ошибка',
      } as const;
      await ctx.answerCallbackQuery({ text: map[result] });
    } else {
      const result = manager.startClicker(id);
      const map = {
        ok: 'Кликер вкл',
        offline: 'Бот оффлайн',
        already: 'Уже включён',
        fail: 'Ошибка',
      } as const;
      await ctx.answerCallbackQuery({ text: map[result] });
      if (result === 'ok') {
        const record = db.getBot(id);
        void ctx.reply(`🖱 [#${id}] Кликер ПКМ включён (${record?.clickerCps ?? '?'} CPS)`);
      }
    }

    const record = db.getBot(id);
    if (record) {
      await editOrReply(ctx, botCardText(record, manager), botActionsKeyboard(record, manager));
    }
  });

  bot.callbackQuery(/^bot:(\d+):clicker:cps$/, async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    const id = Number(ctx.match![1]);
    const record = db.getBot(id);
    if (!record) return ctx.answerCallbackQuery({ text: 'Не найден' });
    clearAwait(ctx);
    await ctx.answerCallbackQuery();
    await editOrReply(
      ctx,
      `Кликер ПКМ — CPS для #${id}\nСейчас: <b>${record.clickerCps}</b>\nВыбери пресет или своё число (1–20)`,
      clickerCpsKeyboard(id),
    );
  });

  bot.callbackQuery(/^bot:(\d+):clicker:cps:custom$/, async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    const id = Number(ctx.match![1]);
    clearAwait(ctx);
    ctx.session.awaitBotId = id;
    ctx.session.awaitKind = 'set_clicker_cps';
    await ctx.answerCallbackQuery();
    await editOrReply(
      ctx,
      'Введи CPS числом от 1 до 20\n/cancel — отмена',
      new InlineKeyboard().text('« Назад', `bot:${id}:clicker:cps`),
    );
  });

  bot.callbackQuery(/^bot:(\d+):clicker:cps:(\d+)$/, async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    const id = Number(ctx.match![1]);
    const cps = Number(ctx.match![2]);
    if (!manager.setClickerCps(id, cps)) {
      await ctx.answerCallbackQuery({ text: 'Ошибка' });
      return;
    }
    await ctx.answerCallbackQuery({ text: `CPS = ${cps}` });
    const updated = db.getBot(id)!;
    await editOrReply(
      ctx,
      `Настройки #${id}\n${botCardText(updated, manager)}`,
      settingsKeyboard(updated),
    );
  });

  bot.callbackQuery(/^bot:(\d+):settings$/, async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    clearAwait(ctx);
    const id = Number(ctx.match![1]);
    const record = db.getBot(id);
    if (!record) return ctx.answerCallbackQuery({ text: 'Не найден' });
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, `Настройки #${id}\n${botCardText(record, manager)}`, settingsKeyboard(record));
  });

  bot.callbackQuery(/^bot:(\d+):set:(nick|password|proxy)$/, async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    const id = Number(ctx.match![1]);
    const field = ctx.match![2] as 'nick' | 'password' | 'proxy';
    clearAwait(ctx);
    ctx.session.awaitBotId = id;
    ctx.session.awaitKind =
      field === 'nick' ? 'set_nick' : field === 'password' ? 'set_password' : 'set_proxy';

    const hints = {
      nick: 'Введи ник пиратки (3–16: A-Z a-z 0-9 _)',
      password: 'Введи пароль FunTime для /login (или "-" чтобы очистить)',
      proxy: 'Введи прокси:\n<code>host:port:user:pass</code>\nили <code>user:pass@host:port</code>\n"-" — убрать прокси',
    } as const;

    await ctx.answerCallbackQuery();
    await editOrReply(
      ctx,
      `${hints[field]}\n/cancel — отмена`,
      new InlineKeyboard().text('« Назад', `bot:${id}:settings`),
    );
  });

  bot.callbackQuery(/^bot:(\d+):toggle:reconnect$/, async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    const id = Number(ctx.match![1]);
    const record = db.getBot(id);
    if (!record) return ctx.answerCallbackQuery({ text: 'Не найден' });
    db.updateBot(id, { reconnect: !record.reconnect });
    const session = manager.getSession(id);
    if (session) session.reconnect = !record.reconnect;
    await ctx.answerCallbackQuery({ text: 'Ок' });
    const updated = db.getBot(id)!;
    await editOrReply(ctx, `Настройки #${id}\n${botCardText(updated, manager)}`, settingsKeyboard(updated));
  });

  bot.callbackQuery(/^bot:(\d+):delete$/, async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    const id = Number(ctx.match![1]);
    await ctx.answerCallbackQuery();
    await editOrReply(
      ctx,
      `Удалить бота #${id}?`,
      new InlineKeyboard()
        .text('Да, удалить', `bot:${id}:delete:confirm`)
        .text('Нет', `bot:${id}:settings`),
    );
  });

  bot.callbackQuery(/^bot:(\d+):delete:confirm$/, async (ctx) => {
    if (!ensureAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    const id = Number(ctx.match![1]);
    manager.turnOff(id);
    db.deleteBot(id);
    await ctx.answerCallbackQuery({ text: 'Удалён' });
    await editOrReply(ctx, 'Бот удалён. Список:', botsListKeyboard(manager));
  });

  bot.on('message:text', async (ctx) => {
    if (!ensureAdmin(ctx)) return;
    const kind = ctx.session.awaitKind;
    if (!kind) return;

    const text = ctx.message.text.trim();
    if (text === '/cancel') {
      clearAwait(ctx);
      await ctx.reply('Отменено.', { reply_markup: mainMenuKeyboard() });
      return;
    }

    if (kind === 'add_nick') {
      if (!isValidNick(text)) {
        await ctx.reply('Ник: 3–16 символов, только латиница/цифры/_. Ещё раз или /cancel');
        return;
      }
      ctx.session.draftNick = text;
      ctx.session.awaitKind = 'add_password';
      await ctx.reply(
        'Введи пароль аккаунта FunTime (для /login и /reg).',
        { reply_markup: new InlineKeyboard().text('« Отмена', 'bots:list') },
      );
      return;
    }

    if (kind === 'add_password') {
      ctx.session.draftPassword = text === '-' ? '' : text;
      ctx.session.awaitKind = 'add_proxy';
      await ctx.reply(
        'Введи прокси `host:port:user:pass` или "-" без прокси.',
        {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard().text('« Отмена', 'bots:list'),
        },
      );
      return;
    }

    if (kind === 'add_proxy') {
      const nick = ctx.session.draftNick!;
      const password = ctx.session.draftPassword ?? '';
      let proxy = null;
      if (text !== '-') {
        proxy = parseProxy(text);
        if (!proxy) {
          await ctx.reply('Неверный формат прокси. Ещё раз или "-"');
          return;
        }
      }
      const created = db.addBot({ email: nick, password, proxy, label: nick });
      clearAwait(ctx);
      await ctx.reply(`Бот #${created.id} (${nick}) добавлен — FunTime пиратка.`, {
        reply_markup: botsListKeyboard(manager),
      });
      return;
    }

    if (kind === 'send_chat') {
      const botId = ctx.session.awaitBotId!;
      const result = manager.sendChat(botId, text);
      const msg =
        result === 'ok'
          ? 'Сообщение отправлено'
          : result === 'offline'
            ? 'Бот оффлайн'
            : 'Не удалось отправить';
      clearAwait(ctx);
      const record = db.getBot(botId);
      await ctx.reply(msg, {
        reply_markup: record
          ? botActionsKeyboard(record, manager)
          : mainMenuKeyboard(),
      });
      return;
    }

    const botId = ctx.session.awaitBotId;
    if (!botId) {
      clearAwait(ctx);
      return;
    }

    if (kind === 'set_clicker_cps') {
      const cps = Number(text.replace(',', '.'));
      if (!Number.isFinite(cps) || cps < 1 || cps > 20) {
        await ctx.reply('Нужно число от 1 до 20');
        return;
      }
      manager.setClickerCps(botId, cps);
      clearAwait(ctx);
      const record = db.getBot(botId)!;
      await ctx.reply(`Кликер CPS = ${record.clickerCps}`, {
        reply_markup: settingsKeyboard(record),
      });
      return;
    }

    if (kind === 'set_nick') {
      if (!isValidNick(text)) {
        await ctx.reply('Ник: 3–16, латиница/цифры/_');
        return;
      }
      manager.invalidate(botId);
      db.updateBot(botId, { email: text, label: text });
      clearAwait(ctx);
      const record = db.getBot(botId)!;
      await ctx.reply('Ник обновлён (перезапусти бота).', {
        reply_markup: settingsKeyboard(record),
      });
      return;
    }

    if (kind === 'set_password') {
      manager.invalidate(botId);
      db.updateBot(botId, { password: text === '-' ? '' : text });
      clearAwait(ctx);
      const record = db.getBot(botId)!;
      await ctx.reply('Пароль обновлён.', { reply_markup: settingsKeyboard(record) });
      return;
    }

    if (kind === 'set_proxy') {
      let proxy = null;
      if (text !== '-') {
        proxy = parseProxy(text);
        if (!proxy) {
          await ctx.reply('Неверный формат прокси');
          return;
        }
      }
      manager.invalidate(botId);
      db.updateBot(botId, { proxy });
      clearAwait(ctx);
      const record = db.getBot(botId)!;
      await ctx.reply('Прокси обновлён.', { reply_markup: settingsKeyboard(record) });
    }
  });
}
