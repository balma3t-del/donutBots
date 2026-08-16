import { Bot, InlineKeyboard, session } from 'grammy';
import type { Context, SessionFlavor } from 'grammy';
import { BOT_TOKEN } from './config.js';
import type { SessionData } from './handlers/types.js';

export type BotContext = Context & SessionFlavor<SessionData>;

export const bot = new Bot<BotContext>(BOT_TOKEN);

bot.use(
  session({
    initial: (): SessionData => ({}),
  }),
);

export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Мои боты', 'bots:list')
    .row()
    .text('Добавить бота', 'bots:add');
}

export function clearAwait(ctx: BotContext) {
  ctx.session.awaitKind = null;
  ctx.session.awaitBotId = undefined;
  ctx.session.draftNick = undefined;
  ctx.session.draftPassword = undefined;
}
