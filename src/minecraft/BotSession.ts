import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import mineflayer, { type Bot } from 'mineflayer';
import { SocksClient } from 'socks';
import type { Client } from 'minecraft-protocol';
import {
  ALREADY_ONLINE_MAX_STREAK,
  ALREADY_ONLINE_RECONNECT_MS,
  AUTH_TIMEOUT_MS,
  DEFAULT_CLICKER_CPS,
  JOIN_SPIN_MS,
  MC_HOST,
  MC_PORT,
  MC_VERSION,
  PROXY_DOWN_RECONNECT_MS,
  RECONNECT_DELAY_MS,
  clampCps,
} from '../config.js';
import type { ProxyConfig } from '../handlers/types.js';
import { captchaEnabled, solveFuntimeCaptcha } from '../utils/captchaSolver.js';
import { checkProxyWorking, hasProxy } from '../utils/proxy.js';
import { logger } from '../utils/logger.js';
import { formatWindowDump } from './formatWindow.js';
import { attachFuntimeAuth } from './funtimeAuth.js';

const require = createRequire(import.meta.url);
// CJS package
const FlayerCaptcha = require('flayercaptcha') as new (
  bot: Bot,
  config?: { delay?: number; isStopped?: boolean },
) => {
  on(
    event: 'imageReady',
    cb: (payload: {
      data: { facing?: string; minDistance?: number; viewDirection?: string };
      image: { png: () => { toBuffer: () => Promise<Buffer> } };
    }) => void | Promise<void>,
  ): void;
  stop?: () => void;
};

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
  /** Ник пиратки (offline). */
  nick: string;
  /** Пароль для /login /reg на FunTime. */
  password?: string;
  proxy?: ProxyConfig | null;
  reconnect: boolean;
  clickerCps?: number;
  notify: NotifyFn;
};

function chatToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);

  const obj = value as Record<string, any>;

  if (obj.type === 'compound' && obj.value && typeof obj.value === 'object') {
    return chatToText(obj.value);
  }
  if (obj.type === 'string' && 'value' in obj) {
    return String(obj.value ?? '');
  }
  if (obj.type === 'list' && obj.value?.value) {
    const items = obj.value.value;
    if (Array.isArray(items)) return items.map(chatToText).join('');
  }

  if (typeof obj.text === 'string' && obj.text) {
    let result = obj.text;
    if (Array.isArray(obj.extra)) result += obj.extra.map(chatToText).join('');
    return result;
  }
  if (obj.text && typeof obj.text === 'object') {
    let result = chatToText(obj.text);
    if (obj.extra) result += chatToText(obj.extra);
    return result;
  }
  if (obj.extra) return chatToText(obj.extra);
  if (obj.translate) {
    const withArgs = Array.isArray(obj.with)
      ? `${obj.translate}: ${obj.with.map(chatToText).join(' ')}`
      : String(obj.translate);
    return withArgs;
  }
  if (obj.value != null && typeof obj.value !== 'object') return String(obj.value);

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Сессия mineflayer: только пиратка (offline) → FunTime (mc.funtime.su).
 * Авто /login|/reg + капча (CapMonster, если задан ключ).
 */
export class BotSession extends EventEmitter {
  readonly id: number;
  nick: string;
  password: string;
  proxy: ProxyConfig | null;
  reconnect: boolean;
  clickerCps: number;
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

  nearbyRadius = 64;
  nearbyPlayers = new Map<string, string>();

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nearbyScanTimer: ReturnType<typeof setInterval> | null = null;
  private clickerTimer: ReturnType<typeof setInterval> | null = null;
  private authTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private joinSpinToken = 0;
  private lastDisconnectReason: string | null = null;
  private disconnectNotified = false;
  private alreadyOnlineStreak = 0;
  private captchaSolving = false;
  private captchaSolved = false;
  private captchaHandler: InstanceType<typeof FlayerCaptcha> | null = null;
  /** Уже делали авто /dm после входа. */
  private autoDmDone = false;

  constructor(opts: BotSessionOptions) {
    super();
    this.id = opts.id;
    this.nick = opts.nick.trim();
    this.password = opts.password?.trim() || '';
    this.proxy = opts.proxy ?? null;
    this.reconnect = opts.reconnect;
    this.clickerCps = clampCps(opts.clickerCps ?? DEFAULT_CLICKER_CPS);
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

    if (!this.nick) {
      void this.notify(`❌ [#${this.id}] Не задан ник (пиратка)`);
      return;
    }

    if (!isValidOfflineNick(this.nick)) {
      void this.notify(
        `❌ [#${this.id}] Ник <code>${escapeHtml(this.nick)}</code> невалиден.\n`
        + `3–16 символов: латиница, цифры, _`,
      );
      return;
    }

    this.stopped = false;
    this.isConnect = true;
    this.isActive = false;
    this.isSpawned = false;
    this.isProxyDown = false;
    this.isAuthFailed = false;
    this.isClickerOn = false;
    this.captchaSolving = false;
    this.captchaSolved = false;
    this.autoDmDone = false;
    this.stopClickerTimer();
    this.lastDisconnectReason = null;
    this.disconnectNotified = false;
    this.inGameName = null;
    this.nearbyPlayers.clear();

    const timeoutMin = Math.round(AUTH_TIMEOUT_MS / 60_000);
    void this.notify(
      `🔄 [#${this.id}] FunTime пиратка <b>${escapeHtml(this.nick)}</b>...\n`
      + `<code>${MC_HOST}:${MC_PORT}</code> · offline\n`
      + (captchaEnabled()
        ? 'Капча: CapMonster вкл'
        : '⚠️ CAPMONSTER_API_KEY не задан — капчу не решу')
      + `\n⏱ Таймаут: ${timeoutMin} мин.`,
    );

    this.armAuthTimeout();

    const botOptions: Record<string, unknown> = {
      username: this.nick,
      // Явно offline — без Microsoft / лицензии
      auth: 'offline',
      version: MC_VERSION,
      host: MC_HOST,
      port: MC_PORT,
      physicsEnabled: false,
      brand: 'vanilla',
      keepAlive: true,
      viewDistance: 2,
      hideErrors: true,
    };

    if (hasProxy(this.proxy)) {
      botOptions.connect = (client: Client) => this.createProxyConnection(client);
    }

    try {
      this.bot = mineflayer.createBot(botOptions as any);
      this.bindClientGuards();
      attachFuntimeAuth(this.bot, this.password, this.id);
      this.attachCaptcha();
      this.bindEvents();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[bot #${this.id}] createBot failed`, error);
      this.clearAuthTimeout();
      this.isConnect = false;
      this.isAuthFailed = true;
      void this.notify(`❌ [#${this.id}] Не удалось создать сессию: <code>${escapeHtml(msg)}</code>`);
    }
  }

  quit(disableReconnect = false) {
    if (disableReconnect) this.reconnect = false;
    this.stopped = true;
    this.joinSpinToken += 1;
    this.clearAuthTimeout();
    this.stopClicker(false);
    this.stopNearbyScan();
    try {
      this.captchaHandler?.stop?.();
    } catch {
      // ignore
    }
    this.captchaHandler = null;
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

  private attachCaptcha() {
    const bot = this.bot;
    if (!bot || !captchaEnabled()) return;

    try {
      this.captchaHandler = new FlayerCaptcha(bot, { delay: 10, isStopped: false });
      this.captchaHandler.on('imageReady', async ({ data, image }) => {
        if (this.stopped || this.captchaSolved || this.captchaSolving) return;
        if (data.facing && data.facing !== 'forward') return;

        this.captchaSolving = true;
        try {
          const buffer = await image.png().toBuffer();
          const image64 = buffer.toString('base64');
          logger.info(`[bot #${this.id}] captcha image ready, solving...`);
          void this.notify(`🧩 [#${this.id}] Капча — отправляю в CapMonster...`);

          const ans = await solveFuntimeCaptcha(image64);
          if (!ans || this.stopped || !this.bot) {
            void this.notify(`❌ [#${this.id}] Капча не решена`);
            return;
          }

          this.captchaSolved = true;
          logger.info(`[bot #${this.id}] captcha answer: ${ans}`);
          this.bot.chat(ans);
          void this.notify(`✅ [#${this.id}] Капча: <code>${escapeHtml(ans)}</code>`);
        } catch (error) {
          logger.error(`[bot #${this.id}] captcha solve error`, error);
          void this.notify(`❌ [#${this.id}] Ошибка решения капчи`);
        } finally {
          this.captchaSolving = false;
        }
      });
    } catch (error) {
      logger.error(`[bot #${this.id}] FlayerCaptcha init failed`, error);
    }
  }

  private async smoothSpin360() {
    const bot = this.bot;
    if (!bot?.entity || !this.isSpawned || this.stopped) return;

    const token = ++this.joinSpinToken;
    const startYaw = bot.entity.yaw;
    const basePitch = bot.entity.pitch;
    const duration = JOIN_SPIN_MS;
    const stepMs = 55 + Math.floor(Math.random() * 25);
    const steps = Math.max(24, Math.round(duration / stepMs));
    const dir = Math.random() < 0.5 ? 1 : -1;

    logger.info(`[bot #${this.id}] join spin start (${duration}ms, steps=${steps})`);

    for (let i = 1; i <= steps; i++) {
      if (token !== this.joinSpinToken || !this.bot?.entity || this.stopped || !this.isSpawned) {
        return;
      }

      const t = i / steps;
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const yaw = startYaw + dir * Math.PI * 2 * eased;
      const pitch = basePitch + Math.sin(t * Math.PI * 2) * 0.02;

      try {
        await this.bot.look(yaw, pitch, true);
      } catch {
        return;
      }

      const jitter = stepMs + Math.floor(Math.random() * 20) - 8;
      await sleep(Math.max(40, jitter));
    }

    if (token === this.joinSpinToken && this.bot?.entity && !this.stopped) {
      try {
        await this.bot.look(this.bot.entity.yaw, basePitch, true);
      } catch {
        // ignore
      }
    }

    logger.info(`[bot #${this.id}] join spin done`);
  }

  private armAuthTimeout() {
    this.clearAuthTimeout();
    this.authTimeoutTimer = setTimeout(() => {
      if (this.isSpawned || this.stopped) return;
      logger.warn(`[bot #${this.id}] connect timeout`);
      this.isAuthFailed = true;
      this.reconnect = false;
      void this.notify(
        `⏰ [#${this.id}] Таймаут входа на FunTime.\n`
        + `Проверь ник/пароль, прокси и CapMonster ключ.`,
      );
      this.quit(true);
    }, AUTH_TIMEOUT_MS);
  }

  private clearAuthTimeout() {
    if (this.authTimeoutTimer) {
      clearTimeout(this.authTimeoutTimer);
      this.authTimeoutTimer = null;
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

  /**
   * Пишет /dm, ждёт открытия GUI и возвращает текстовый дамп слотов.
   */
  async runDm(timeoutMs = 12_000): Promise<
    { ok: true; text: string } | { ok: false; reason: 'offline' | 'timeout' | 'fail'; error?: string }
  > {
    const bot = this.bot;
    if (!bot || !this.isActive) return { ok: false, reason: 'offline' };

    try {
      if (bot.currentWindow) {
        try {
          bot.closeWindow(bot.currentWindow);
        } catch {
          // ignore
        }
        await sleep(300);
      }

      const dump = await new Promise<string>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error('timeout'));
        }, timeoutMs);

        const finish = async (window: import('prismarine-windows').Window) => {
          if (settled) return;
          // FunTime иногда шлёт слоты чуть позже open
          await sleep(600);
          if (settled) return;
          settled = true;
          cleanup();
          resolve(formatWindowDump(window, this.id));
        };

        const onOpen = (window: import('prismarine-windows').Window) => {
          void finish(window);
        };

        const cleanup = () => {
          clearTimeout(timer);
          bot.removeListener('windowOpen', onOpen);
        };

        bot.once('windowOpen', onOpen);
        logger.info(`[bot #${this.id}] chat /dm`);
        bot.chat('/dm');
      });

      return { ok: true, text: dump };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === 'timeout') return { ok: false, reason: 'timeout' };
      logger.error(`[bot #${this.id}] runDm failed`, error);
      return { ok: false, reason: 'fail', error: msg };
    }
  }

  /** Заход на режим /an305, пауза, затем /dm + дамп окна. */
  async runAn305ThenDm() {
    const bot = this.bot;
    if (!bot || !this.isActive || !this.isSpawned) {
      void this.notify(`❌ [#${this.id}] /an305: бот оффлайн`);
      return;
    }

    void this.notify(`⚔ [#${this.id}] Пишу <code>/an305</code>...`);
    try {
      bot.chat('/an305');
      logger.info(`[bot #${this.id}] chat /an305`);
    } catch (error) {
      logger.error(`[bot #${this.id}] /an305 failed`, error);
      void this.notify(`❌ [#${this.id}] Не удалось отправить /an305`);
      return;
    }

    // Ждём телепорт/загрузку режима
    await sleep(8_000);
    if (this.stopped || !this.isActive) return;

    void this.notify(`📨 [#${this.id}] На /an305 — пишу <code>/dm</code>...`);
    const result = await this.runDm();
    if (result.ok) {
      void this.notify(result.text);
      return;
    }
    if (result.reason === 'timeout') {
      void this.notify(
        `⏰ [#${this.id}] /dm после /an305: окно не открылось за 12с`,
      );
      return;
    }
    void this.notify(
      `❌ [#${this.id}] /dm ошибка: <code>${escapeHtml(result.error ?? result.reason)}</code>`,
    );
  }

  async runDmAndNotify() {
    void this.notify(`📨 [#${this.id}] Пишу <code>/dm</code>...`);
    const result = await this.runDm();
    if (result.ok) {
      void this.notify(result.text);
      return;
    }
    if (result.reason === 'offline') {
      void this.notify(`❌ [#${this.id}] /dm: бот оффлайн`);
      return;
    }
    if (result.reason === 'timeout') {
      void this.notify(
        `⏰ [#${this.id}] /dm: окно не открылось за 12с.\n`
        + `Возможно ещё хаб/капча/логин — попробуй кнопку «/dm» позже.`,
      );
      return;
    }
    void this.notify(
      `❌ [#${this.id}] /dm ошибка: <code>${escapeHtml(result.error ?? 'fail')}</code>`,
    );
  }

  startClicker(): 'ok' | 'offline' | 'already' | 'fail' {
    const bot = this.bot;
    if (!bot || !this.isActive || !this.isSpawned) return 'offline';
    if (this.isClickerOn) return 'already';

    try {
      this.isClickerOn = true;
      this.armClickerTimer();
      logger.info(`[bot #${this.id}] RMB clicker on (${this.clickerCps} CPS)`);
      return 'ok';
    } catch (error) {
      logger.error(`[bot #${this.id}] startClicker failed`, error);
      this.isClickerOn = false;
      this.stopClickerTimer();
      return 'fail';
    }
  }

  stopClicker(notify = true): 'ok' | 'offline' | 'not_running' | 'fail' {
    this.stopClickerTimer();
    if (!this.isClickerOn) return 'not_running';
    this.isClickerOn = false;
    try {
      this.bot?.deactivateItem();
    } catch {
      // ignore
    }
    logger.info(`[bot #${this.id}] RMB clicker off`);
    if (notify) void this.notify(`🖐 [#${this.id}] Кликер ПКМ выключен`);
    return this.bot && this.isActive ? 'ok' : 'offline';
  }

  setClickerCps(cps: number) {
    this.clickerCps = clampCps(cps);
    if (this.isClickerOn) this.armClickerTimer();
  }

  private armClickerTimer() {
    this.stopClickerTimer();
    const intervalMs = Math.max(50, Math.round(1000 / this.clickerCps));
    this.clickerTimer = setInterval(() => this.clickOnce(), intervalMs);
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
      bot.activateItem();
      setTimeout(() => {
        if (!this.bot || !this.isClickerOn) return;
        try {
          this.bot.deactivateItem();
        } catch {
          // ignore
        }
      }, 30);
    } catch (error) {
      logger.warn(`[bot #${this.id}] RMB click failed`, error);
    }
  }

  getNearbyPlayers(radius = this.nearbyRadius): NearbyPlayer[] {
    const bot = this.bot;
    if (!bot?.entity?.position) return [];

    const selfName = bot.username?.toLowerCase();
    const origin = bot.entity.position;
    const result: NearbyPlayer[] = [];
    const seen = new Set<string>();

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
      this.clearAuthTimeout();
      this.isConnect = false;
      this.isActive = true;
      this.inGameName = bot.username;
      void this.notify(`✅ [#${this.id}] Онлайн (пиратка) как <b>${bot.username}</b>`);
      this.emit('online', bot.username);
    });

    bot.once('spawn', () => {
      this.clearAuthTimeout();
      this.isSpawned = true;
      this.alreadyOnlineStreak = 0;
      this.inGameName = bot.username;
      logger.info(`[bot #${this.id}] spawn @ ${bot.username}`);
      this.emit('spawn');
      this.startNearbyScan();
      setTimeout(() => {
        void this.smoothSpin360();
      }, 800 + Math.floor(Math.random() * 700));

      // После входа: /an305 → /dm + дамп окна (один раз за сессию)
      if (!this.autoDmDone) {
        this.autoDmDone = true;
        setTimeout(() => {
          if (this.stopped || !this.isActive || !this.isSpawned) return;
          void this.runAn305ThenDm();
        }, 6_000);
      }
    });

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

    bot.on('kicked', (reason) => {
      const text = chatToText(reason) || 'unknown kick';
      this.lastDisconnectReason = `kick: ${text}`;
      logger.warn(`[bot #${this.id}] kicked: ${text}`);
      this.notifyDisconnect(`🚪 [#${this.id}] Кикнут с сервера\n<code>${escapeHtml(text.slice(0, 500))}</code>`);
    });

    bot._client.on('disconnect', (packet: { reason?: unknown }) => {
      const text = chatToText(packet?.reason) || 'disconnect packet';
      this.lastDisconnectReason = `disconnect: ${text}`;
      logger.warn(`[bot #${this.id}] disconnect packet: ${text}`);
    });

    bot.on('error', (err) => {
      logger.error(`[bot #${this.id}] error: ${err.message}`);
      if (!this.lastDisconnectReason) {
        this.lastDisconnectReason = `error: ${err.message}`;
      }
    });

    bot.once('end', (reason?: string) => {
      this.joinSpinToken += 1;
      this.clearAuthTimeout();
      this.stopClicker(false);
      this.stopNearbyScan();
      this.isConnect = false;
      this.isActive = false;
      try {
        this.captchaHandler?.stop?.();
      } catch {
        // ignore
      }
      this.captchaHandler = null;

      const endReason = reason?.trim() || 'no reason';
      const detail = this.lastDisconnectReason
        ? `${this.lastDisconnectReason}\nend: ${endReason}`
        : `end: ${endReason}`;
      logger.warn(`[bot #${this.id}] end | ${detail}`);

      if (!this.disconnectNotified) {
        this.notifyDisconnect(
          `❗ [#${this.id}] Отключён\n<code>${escapeHtml(detail.slice(0, 500))}</code>`,
        );
      }

      this.emit('end', detail);
      this.scheduleReconnect();
    });
  }

  private notifyDisconnect(text: string) {
    if (this.disconnectNotified) return;
    this.disconnectNotified = true;
    void this.notify(text);
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

    const reasonText = this.lastDisconnectReason ?? '';
    const alreadyOnline = isAlreadyOnlineReason(reasonText);

    if (alreadyOnline) {
      this.alreadyOnlineStreak += 1;
      if (this.alreadyOnlineStreak >= ALREADY_ONLINE_MAX_STREAK) {
        this.reconnect = false;
        this.clear();
        void this.notify(
          `⛔ [#${this.id}] Стоп реконнекта: ${this.alreadyOnlineStreak}× «already online».\n`
          + `Подожди 2–5 мин, потом «Включить» вручную.`,
        );
        return;
      }
    } else if (this.isSpawned || this.isActive) {
      this.alreadyOnlineStreak = 0;
    }

    let delay = RECONNECT_DELAY_MS;
    let delayNote = '';
    if (this.isProxyDown) {
      delay = PROXY_DOWN_RECONNECT_MS;
      delayNote = ' (прокси)';
    } else if (alreadyOnline) {
      delay = ALREADY_ONLINE_RECONNECT_MS * this.alreadyOnlineStreak;
      delayNote = ` (already online ×${this.alreadyOnlineStreak})`;
    } else if (/kick:|disconnect:/i.test(reasonText)) {
      delay = Math.max(RECONNECT_DELAY_MS, 15_000);
      delayNote = ' (после кика)';
    }

    this.clear();
    void this.notify(
      `♻ [#${this.id}] Реконнект через ${Math.round(delay / 1000)}с${delayNote}...`,
    );
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped && this.reconnect) this.create();
    }, delay);
  }

  clear() {
    this.clearAuthTimeout();
    this.stopClickerTimer();
    this.isClickerOn = false;
    this.stopNearbyScan();
    this.isConnect = false;
    this.isActive = false;
    this.isSpawned = false;
    this.lastDisconnectReason = null;
    this.disconnectNotified = false;
    this.captchaSolving = false;
    this.captchaSolved = false;
    this.bot = null;
  }
}

function isValidOfflineNick(nick: string): boolean {
  return /^[A-Za-z0-9_]{3,16}$/.test(nick);
}

function isAlreadyOnlineReason(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes('already online')
    || t.includes('уже онлайн')
    || t.includes('already connected')
    || t.includes('already logged')
  );
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
