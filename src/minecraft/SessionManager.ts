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
 * Менеджер активных mineflayer-сессий.
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
        result.push(session.inGameName || session.email);
      }
    }
    return result;
  }

  async turnOn(botId: number): Promise<'ok' | 'already' | 'missing' | 'no_email'> {
    const record = db.getBot(botId);
    if (!record) return 'missing';
    if (!record.email.trim()) return 'no_email';

    const existing = this.sessions.get(botId);
    if (existing?.isActive || existing?.isConnect) return 'already';
    if (existing) {
      existing.quit(true);
      this.sessions.delete(botId);
    }

    const session = new BotSession({
      id: record.id,
      email: record.email,
      password: record.password,
      proxy: toProxy(record),
      reconnect: record.reconnect,
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

  getNearbyPlayers(botId: number): { offline: true } | { offline: false; text: string; count: number } {
    const session = this.sessions.get(botId);
    if (!session?.isActive || !session.isSpawned) return { offline: true };
    const list = session.getNearbyPlayers();
    return { offline: false, text: session.formatNearbyList(), count: list.length };
  }

  isHoldingRmb(botId: number): boolean {
    return Boolean(this.sessions.get(botId)?.isHoldingRmb);
  }

  holdRmb(botId: number): 'ok' | 'offline' | 'already' | 'fail' {
    const session = this.sessions.get(botId);
    if (!session) return 'offline';
    return session.holdRmb();
  }

  releaseRmb(botId: number): 'ok' | 'offline' | 'not_holding' | 'fail' {
    const session = this.sessions.get(botId);
    if (!session) return 'offline';
    return session.releaseRmb(true);
  }

  /** После обновления конфига — выключить, чтобы при следующем старте взялись новые данные. */
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
