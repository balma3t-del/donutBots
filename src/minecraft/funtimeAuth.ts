import type { Bot } from 'mineflayer';
import { logger } from '../utils/logger.js';

/**
 * Авто /reg и /login для FunTime (AuthMe, RU + EN).
 * Работает без mineflayer-auto-auth — паттерны сервера русские.
 */
export function attachFuntimeAuth(bot: Bot, password: string, botId: number) {
  const pass = password.trim();
  if (!pass) {
    logger.warn(`[bot #${botId}] пароль пустой — /login не будет отправлен`);
    return;
  }

  let sentLogin = false;
  let sentReg = false;

  const tryAuth = (raw: string) => {
    const text = stripColor(raw).toLowerCase();

    const wantsReg =
      text.includes('/reg')
      || text.includes('зарегистрируйтесь')
      || text.includes('зарегистрироваться')
      || text.includes('register')
      || (text.includes('регистрац') && text.includes('парол'));

    const wantsLogin =
      text.includes('/login')
      || text.includes('/l ')
      || text.includes('авторизируйтесь')
      || text.includes('авторизуйтесь')
      || text.includes('авторизоваться')
      || text.includes('войдите')
      || (text.includes('login') && text.includes('password'));

    if (wantsReg && !sentReg) {
      sentReg = true;
      const cmd = `/reg ${pass} ${pass}`;
      logger.info(`[bot #${botId}] auto-auth register`);
      bot.chat(cmd);
      return;
    }

    if (wantsLogin && !sentLogin) {
      sentLogin = true;
      const cmd = `/login ${pass}`;
      logger.info(`[bot #${botId}] auto-auth login`);
      bot.chat(cmd);
    }
  };

  bot.on('messagestr', (msg) => {
    try {
      tryAuth(String(msg ?? ''));
    } catch (error) {
      logger.warn(`[bot #${botId}] auth parse failed`, error);
    }
  });

  bot.on('message', (jsonMsg) => {
    try {
      tryAuth(jsonMsg?.toString?.() ?? String(jsonMsg));
    } catch {
      // ignore
    }
  });
}

function stripColor(text: string): string {
  return text.replace(/§[0-9a-fk-or]/gi, '');
}
