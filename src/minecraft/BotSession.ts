import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import mineflayer, { type Bot } from 'mineflayer';
import { SocksClient } from 'socks';
import type { Client } from 'minecraft-protocol';
import {
  CLICKER_CPS,
  MC_HOST,
  MC_PORT,
  MC_VERSION,
  PROFILES_FOLDER,
  PROXY_DOWN_RECONNECT_MS,
  RECONNECT_DELAY_MS,
} from '../config.js';
import type { ProxyConfig } from '../handlers/types.js';
import { checkProxyWorking, hasProxy } from '../utils/proxy.js';
import { logger } from '../utils/logger.js';

const MOVEMENT_PACKETS = new Set([
  'position',
  'position_look',
  'look',
  'flying',
  'vehicle_move',
  'player_input',
  'teleport_confirm',
  'entity_action',
]);

export type NearbyPlayer = {
  username: string;
  uuid?: string;
  distance: number;
  x: number;
  y: number;
  z: number;
};

export type NotifyFn = (text: string) => void | Promise<void>;

export type BotSessionOptions = {
  id: number;
  email: string;
  password?: string;
  proxy?: ProxyConfig | null;
  reconnect: boolean;
  notify: NotifyFn;
};

function chatToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  const obj = value as Record<string, unknown>;
  let result = typeof obj.text === 'string' ? obj.text : '';
  if (Array.isArray(obj.extra)) result += obj.extra.map(chatToText).join('');
  if (typeof obj.translate === 'string') result += obj.translate;
  return result || JSON.stringify(value);
}

/**
 * Классовая сессия mineflayer: лицензия (Microsoft), стабильный онлайн через reconnect.
 * Без капчи и без /login — сервер принимает игрока сразу после входа.
 */
export class BotSession extends EventEmitter {
  readonly id: number;
  email: string;
  password: string;
  proxy: ProxyConfig | null;
  reconnect: boolean;
  notify: NotifyFn;

  isConnect = false;
  isActive = false;
  isSpawned = false;
  isProxyDown = false;
  isAuthFailed = false;
  isClickerOn = false;
  stopped = false;

  bot: Bot | null = null;
  inGameName: string | null = null;

  /** Радиус «рядом» (блоки). */
  nearbyRadius = 64;
  /** Ники игроков в радиусе (lowercase → display name). */
  nearbyPlayers = new Map<string, string>();

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nearbyScanTimer: ReturnType<typeof setInterval> | null = null;
  private clickerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: BotSessionOptions) {
    super();
    this.id = opts.id;
    this.email = opts.email;
    this.password = opts.password?.trim() || '';
    this.proxy = opts.proxy ?? null;
    this.reconnect = opts.reconnect;
    this.notify = opts.notify;
  }

  get status(): 'offline' | 'connecting' | 'online' {
    if (this.isActive) return 'online';
    if (this.isConnect) return 'connecting';
    return 'offline';
  }

  create() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (!this.email.trim()) {
      void this.notify(`❌ [#${this.id}] Не задан Microsoft email`);
      return;
    }

    this.stopped = false;
    this.isConnect = true;
    this.isActive = false;
    this.isSpawned = false;
    this.isProxyDown = false;
    this.isAuthFailed = false;
    this.isClickerOn = false;
    this.stopClickerTimer();
    this.inGameName = null;
    this.nearbyPlayers.clear();

    fs.mkdirSync(path.resolve(PROFILES_FOLDER), { recursive: true });

    // Парольный Microsoft-логин часто ломается (MFA / «try removing the password field»).
    // Всегда device-code + кэш токенов в profilesFolder.
    void this.notify(
      `🔄 [#${this.id}] Подключаюсь (${this.email})...\nОжидай код Microsoft в этом чате (если токен ещё не сохранён).`,
    );

    const botOptions: Record<string, unknown> = {
      username: this.email,
      auth: 'microsoft',
      profilesFolder: path.resolve(PROFILES_FOLDER),
      version: MC_VERSION,
      host: MC_HOST,
      port: MC_PORT,
      physicsEnabled: false,
      brand: 'vanilla',
      keepAlive: true,
      viewDistance: 10,
      hideErrors: true,
      onMsaCode: (data: { user_code?: string; verification_uri?: string; message?: string }) => {
        const code = data.user_code ?? '?';
        const uri = data.verification_uri ?? 'https://www.microsoft.com/link';
        const hint = data.message || `Открой ${uri} и введи код ${code}`;
        logger.info(`[bot #${this.id}] MSA code: ${code}`);
        void this.notify(
          `🔐 [#${this.id}] Microsoft auth\n<code>${escapeHtml(hint)}</code>\nКод: <code>${escapeHtml(code)}</code>\nСсылка: ${uri}`,
        );
      },
    };

    if (hasProxy(this.proxy)) {
      botOptions.connect = (client: Client) => this.createProxyConnection(client);
    }

    this.bot = mineflayer.createBot(botOptions as any);
    this.bindClientGuards();
    this.bindEvents();
  }

  quit(disableReconnect = false) {
    if (disableReconnect) this.reconnect = false;
    this.stopped = true;
    this.stopClicker(false);
    this.stopNearbyScan();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.bot?.quit();
    } catch {
      // ignore
    }
  }

  chat(text: string): boolean {
    if (!this.bot || !this.isActive) return false;
    try {
      this.bot.chat(text);
      return true;
    } catch (error) {
      logger.error(`[bot #${this.id}] chat failed`, error);
      return false;
    }
  }

  /** Включить автокликер (ЛКМ): swing + удар по ближайшей цели в досягаемости. */
  startClicker(): 'ok' | 'offline' | 'already' | 'fail' {
    const bot = this.bot;
    if (!bot || !this.isActive || !this.isSpawned) return 'offline';
    if (this.isClickerOn) return 'already';

    try {
      this.isClickerOn = true;
      this.stopClickerTimer();
      const intervalMs = Math.round(1000 / CLICKER_CPS);
      this.clickerTimer = setInterval(() => this.clickOnce(), intervalMs);
      logger.info(`[bot #${this.id}] clicker on (${CLICKER_CPS} CPS)`);
      return 'ok';
    } catch (error) {
      logger.error(`[bot #${this.id}] startClicker failed`, error);
      this.isClickerOn = false;
      this.stopClickerTimer();
      return 'fail';
    }
  }

  /** Выключить автокликер. */
  stopClicker(notify = true): 'ok' | 'offline' | 'not_running' | 'fail' {
    this.stopClickerTimer();
    if (!this.isClickerOn) return 'not_running';
    this.isClickerOn = false;
    logger.info(`[bot #${this.id}] clicker off`);
    if (notify) void this.notify(`🖐 [#${this.id}] Кликер выключен`);
    return this.bot && this.isActive ? 'ok' : 'offline';
  }

  private stopClickerTimer() {
    if (this.clickerTimer) {
      clearInterval(this.clickerTimer);
      this.clickerTimer = null;
    }
  }

  private clickOnce() {
    const bot = this.bot;
    if (!bot || !this.isClickerOn || !this.isActive || !this.isSpawned) {
      this.stopClickerTimer();
      return;
    }

    try {
      const target = bot.nearestEntity((entity) => {
        if (!entity?.position || !bot.entity?.position) return false;
        if (entity === bot.entity) return false;
        const dist = bot.entity.position.distanceTo(entity.position);
        if (dist > 4.5) return false;
        // Игроки и мобы
        return entity.type === 'player' || entity.type === 'mob';
      });

      if (target) {
        bot.attack(target);
      } else {
        bot.swingArm('right');
      }
    } catch (error) {
      logger.warn(`[bot #${this.id}] click failed`, error);
    }
  }

  /**
   * Игроки в радиусе видимости (есть entity у player).
   * Дистанция — евклидово расстояние от бота.
   */
  getNearbyPlayers(radius = this.nearbyRadius): NearbyPlayer[] {
    const bot = this.bot;
    if (!bot?.entity?.position) return [];

    const selfName = bot.username?.toLowerCase();
    const origin = bot.entity.position;
    const result: NearbyPlayer[] = [];
    const seen = new Set<string>();

    // Надёжнее: tab-list + entity в прогрузке
    for (const player of Object.values(bot.players)) {
      const username = player?.username;
      if (!username || username.toLowerCase() === selfName) continue;
      const entity = player.entity;
      if (!entity?.position) continue;

      const distance = origin.distanceTo(entity.position);
      if (distance > radius) continue;

      const key = username.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      result.push({
        username,
        uuid: player.uuid,
        distance: Math.round(distance * 10) / 10,
        x: Math.round(entity.position.x * 10) / 10,
        y: Math.round(entity.position.y * 10) / 10,
        z: Math.round(entity.position.z * 10) / 10,
      });
    }

    // Fallback по entities (на случай рассинхрона players)
    for (const entity of Object.values(bot.entities)) {
      if (!entity || entity.type !== 'player') continue;
      const username = entity.username;
      if (!username || username.toLowerCase() === selfName) continue;
      if (!entity.position) continue;

      const key = username.toLowerCase();
      if (seen.has(key)) continue;

      const distance = origin.distanceTo(entity.position);
      if (distance > radius) continue;
      seen.add(key);

      result.push({
        username,
        uuid: entity.uuid,
        distance: Math.round(distance * 10) / 10,
        x: Math.round(entity.position.x * 10) / 10,
        y: Math.round(entity.position.y * 10) / 10,
        z: Math.round(entity.position.z * 10) / 10,
      });
    }

    result.sort((a, b) => a.distance - b.distance);
    return result;
  }

  formatNearbyList(radius = this.nearbyRadius): string {
    const list = this.getNearbyPlayers(radius);
    if (list.length === 0) {
      return `👁 [#${this.id}] Рядом никого (радиус ${radius})`;
    }
    const lines = list.map(
      (p, i) =>
        `${i + 1}. <b>${escapeHtml(p.username)}</b> — ${p.distance}м`
        + ` <code>${p.x} ${p.y} ${p.z}</code>`,
    );
    return `👁 [#${this.id}] Игроки рядом (${list.length}, ≤${radius}м):\n${lines.join('\n')}`;
  }

  private async createProxyConnection(client: Client) {
    const proxy = this.proxy!;
    try {
      const connection = await SocksClient.createConnection({
        proxy: {
          type: 5,
          host: proxy.host,
          port: proxy.port,
          userId: proxy.user,
          password: proxy.pass,
        },
        destination: { host: MC_HOST, port: MC_PORT },
        command: 'connect',
        timeout: 8_000,
      });

      const socket = connection?.socket;
      if (!socket) throw new Error('Connection failed');

      socket.setKeepAlive(true, 10_000);
      client.setSocket(socket);
      client.emit('connect');
    } catch (error) {
      logger.error(`[bot #${this.id}] proxy connection failed`, error);
      this.quit();
      this.isProxyDown = !(await checkProxyWorking(proxy));
      void this.notify(
        this.isProxyDown
          ? `❌ [#${this.id}] Прокси не работает`
          : `❌ [#${this.id}] Не удалось установить соединение`,
      );
      client.emit('end');
    }
  }

  private bindClientGuards() {
    const bot = this.bot;
    if (!bot) return;

    const origWrite = bot._client.write.bind(bot._client);
    (bot._client as any).write = (name: string, data: unknown) => {
      if (MOVEMENT_PACKETS.has(name) && bot._client.state !== 'play') {
        return;
      }
      return origWrite(name, data);
    };
  }

  private bindEvents() {
    const bot = this.bot;
    if (!bot) return;

    bot.on('resourcePack', (_url, hash) => {
      const stringHash =
        typeof hash === 'object' && (hash as any)?.ascii != null
          ? (hash as any).ascii
          : hash;
      bot._client?.write('resource_pack_receive', {
        result: 0,
        uuid: stringHash,
      });
    });

    bot.once('login', () => {
      this.isConnect = false;
      this.isActive = true;
      this.inGameName = bot.username;
      void this.notify(`✅ [#${this.id}] Онлайн как <b>${bot.username}</b>`);
      this.emit('online', bot.username);
    });

    bot.once('spawn', () => {
      this.isSpawned = true;
      this.inGameName = bot.username;
      logger.info(`[bot #${this.id}] spawn @ ${bot.username}`);
      this.emit('spawn');
      this.startNearbyScan();
    });

    // Мгновенная реакция на появление entity игрока
    bot.on('entitySpawn', (entity) => {
      if (entity?.type === 'player' || entity?.username) {
        this.refreshNearby();
      }
    });
    bot.on('entityUpdate', (entity) => {
      if (entity?.type === 'player' || entity?.username) {
        this.refreshNearby();
      }
    });
    bot.on('playerUpdated', () => {
      this.refreshNearby();
    });
    bot.on('entityGone', (entity) => {
      if (entity?.type === 'player' || entity?.username) {
        this.refreshNearby();
      }
    });

    bot.once('kicked', (reason) => {
      const text = chatToText(reason);
      logger.warn(`[bot #${this.id}] kicked: ${text}`);
      void this.notify(`🚪 [#${this.id}] Кик: <code>${escapeHtml(text.slice(0, 400))}</code>`);
    });

    bot.on('error', (err) => {
      logger.error(`[bot #${this.id}] error: ${err.message}`);
      const msg = err.message.toLowerCase();
      if (msg.includes('authentication') || msg.includes('sign in failed')) {
        this.isAuthFailed = true;
        this.reconnect = false;
        void this.notify(
          `❌ [#${this.id}] Microsoft auth failed.\nВ настройках очисти пароль (отправь "-") и включи снова — придёт device-code.`,
        );
      }
    });

    bot.once('end', (reason?: string) => {
      this.stopClicker(false);
      this.stopNearbyScan();
      this.isConnect = false;
      this.isActive = false;
      logger.warn(`[bot #${this.id}] end: ${reason ?? 'no reason'}`);
      void this.notify(`❗ [#${this.id}] Отключён`);
      this.emit('end', reason);
      this.scheduleReconnect();
    });
  }

  private startNearbyScan() {
    this.stopNearbyScan();
    this.refreshNearby();
    this.nearbyScanTimer = setInterval(() => this.refreshNearby(), 1_000);
    logger.info(`[bot #${this.id}] nearby scan started (radius=${this.nearbyRadius})`);
  }

  private stopNearbyScan() {
    if (this.nearbyScanTimer) {
      clearInterval(this.nearbyScanTimer);
      this.nearbyScanTimer = null;
    }
    this.nearbyPlayers.clear();
  }

  /**
   * Постоянный скан пока аккаунт онлайн.
   * Новый игрок в радиусе → TG: ник + расстояние.
   */
  private refreshNearby() {
    if (!this.bot?.entity?.position || !this.isSpawned || this.stopped) return;

    const current = this.getNearbyPlayers();
    const next = new Map<string, string>();

    for (const p of current) {
      const key = p.username.toLowerCase();
      next.set(key, p.username);

      if (this.nearbyPlayers.has(key)) continue;

      const dist = p.distance.toFixed(1);
      logger.info(`[bot #${this.id}] nearby detect ${p.username} dist=${dist}`);
      void this.notify(
        `👤 [#${this.id}] Обнаружен игрок <b>${escapeHtml(p.username)}</b>\n`
        + `📏 Расстояние: <b>${dist}</b> м\n`
        + `📍 <code>${p.x} ${p.y} ${p.z}</code>`,
      );
      this.emit('nearbyJoin', p.username, p);
    }

    for (const [key, name] of this.nearbyPlayers) {
      if (!next.has(key)) {
        logger.info(`[bot #${this.id}] nearby left ${name}`);
        this.emit('nearbyLeave', name);
      }
    }

    this.nearbyPlayers = next;
  }

  private scheduleReconnect() {
    if (this.stopped || !this.reconnect || this.isAuthFailed) {
      this.clear();
      return;
    }

    const delay = this.isProxyDown ? PROXY_DOWN_RECONNECT_MS : RECONNECT_DELAY_MS;
    this.clear();
    void this.notify(`♻ [#${this.id}] Реконнект через ${Math.round(delay / 1000)}с...`);
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped && this.reconnect) this.create();
    }, delay);
  }

  clear() {
    this.stopClickerTimer();
    this.isClickerOn = false;
    this.stopNearbyScan();
    this.isConnect = false;
    this.isActive = false;
    this.isSpawned = false;
    this.bot = null;
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
