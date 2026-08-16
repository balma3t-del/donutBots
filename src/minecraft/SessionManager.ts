import { db } from '../database/db.js';
import type { BotRecord, ProxyConfig, SessionStatus } from '../handlers/types.js';
import { BotSession, type NotifyFn } from './BotSession.js';
import { logger } from '../utils/logger.js';

function toProxy(bot: BotRecord): ProxyConfig | null {
  if (!bot.proxyHost || !bot.proxyPort) return null;
  return {
    host: bot.proxyHost,
    port: bot.proxyPort,
    user: bot.proxyUser,
    pass: bot.proxyPass,
  };
}

/**
 * Менеджер активных mineflayer-сессий (FunTime / пиратка).
 */
export class SessionManager {
  private sessions = new Map<number, BotSession>();
  private notify: NotifyFn;

  constructor(notify: NotifyFn) {
    this.notify = notify;
  }

  getStatus(botId: number): SessionStatus {
    return this.sessions.get(botId)?.status ?? 'offline';
  }

  getSession(botId: number): BotSession | undefined {
    return this.sessions.get(botId);
  }

  listOnlineNicks(botIds: number[]): string[] {
    const result: string[] = [];
    for (const id of botIds) {
      const session = this.sessions.get(id);
      if (session?.isActive) {
        result.push(session.inGameName || session.nick);
      }
    }
    return result;
  }

  async turnOn(botId: number): Promise<'ok' | 'already' | 'missing' | 'no_nick'> {
    const record = db.getBot(botId);
    if (!record) return 'missing';
    if (!record.email.trim()) return 'no_nick';

    const existing = this.sessions.get(botId);
    if (existing?.isActive || existing?.isConnect) return 'already';
    if (existing) {
      existing.quit(true);
      this.sessions.delete(botId);
    }

    const session = new BotSession({
      id: record.id,
      nick: record.email,
      password: record.password,
      proxy: toProxy(record),
      reconnect: record.reconnect,
      clickerCps: record.clickerCps,
      notify: this.notify,
    });

    this.sessions.set(botId, session);
    session.create();
    logger.info(`[manager] turnOn #${botId}`);
    return 'ok';
  }

  turnOff(botId: number): boolean {
    const session = this.sessions.get(botId);
    if (!session) return false;
    session.quit(true);
    this.sessions.delete(botId);
    logger.info(`[manager] turnOff #${botId}`);
    return true;
  }

  sendChat(botId: number, message: string): 'ok' | 'offline' | 'fail' {
    const session = this.sessions.get(botId);
    if (!session?.isActive) return 'offline';
    return session.chat(message) ? 'ok' : 'fail';
  }

  async runDm(botId: number): Promise<'ok' | 'offline' | 'timeout' | 'fail'> {
    const session = this.sessions.get(botId);
    if (!session?.isActive) return 'offline';
    await session.runAn305ThenDm();
    return session.isActive ? 'ok' : 'offline';
  }

  isClickerOn(botId: number): boolean {
    return Boolean(this.sessions.get(botId)?.isClickerOn);
  }

  startClicker(botId: number): 'ok' | 'offline' | 'already' | 'fail' {
    const session = this.sessions.get(botId);
    if (!session) return 'offline';
    return session.startClicker();
  }

  stopClicker(botId: number): 'ok' | 'offline' | 'not_running' | 'fail' {
    const session = this.sessions.get(botId);
    if (!session) return 'offline';
    return session.stopClicker(true);
  }

  setClickerCps(botId: number, cps: number): boolean {
    const ok = db.updateBot(botId, { clickerCps: cps });
    if (!ok) return false;
    const session = this.sessions.get(botId);
    const updated = db.getBot(botId);
    if (session && updated) session.setClickerCps(updated.clickerCps);
    return true;
  }

  invalidate(botId: number) {
    const session = this.sessions.get(botId);
    if (!session) return;
    session.quit(true);
    this.sessions.delete(botId);
  }

  shutdownAll() {
    for (const [id, session] of this.sessions) {
      session.quit(true);
      this.sessions.delete(id);
    }
  }
}
