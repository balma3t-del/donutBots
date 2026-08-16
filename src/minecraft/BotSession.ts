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
import { findGoldIngotSlot, formatWindowDumpChunks, listWindowItemNames } from './formatWindow.js';
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

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private clickerTimer: ReturnType<typeof setInterval> | null = null;
  private authTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private joinSpinToken = 0;
  private lastDisconnectReason: string | null = null;
  private disconnectNotified = false;
  private alreadyOnlineStreak = 0;
  private captchaSolving = false;
  private captchaSolved = false;
  private captchaHandler: InstanceType<typeof FlayerCaptcha> | null = null;
  /** Уже делали авто /an305→/dm после входа. */
  private autoDmDone = false;
  /** AuthMe /login прошёл. */
  private serverAuthOk = false;
  /** Бот в хабе (можно /an*). */
  private hubReady = false;

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
    this.serverAuthOk = false;
    this.hubReady = false;

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
          // После капчи хаб может уже быть — ждём links, иначе fallback через 12с
          this.tryScheduleAn305();
          setTimeout(() => {
            if (this.autoDmDone || this.stopped) return;
            if (!this.hubReady) {
              this.hubReady = true;
              logger.info(`[bot #${this.id}] hub ready fallback after captcha`);
              this.tryScheduleAn305();
            }
          }, 12_000);
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
   * /dm → клик по золотому слитку → дамп следующего окна с предметами.
   */
  async runDm(timeoutMs = 15_000): Promise<
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

      const first = await this.waitForWindow(timeoutMs, () => {
        logger.info(`[bot #${this.id}] chat /dm`);
        bot.chat('/dm');
      });

      await sleep(500);
      const goldSlot = findGoldIngotSlot(first);
      if (goldSlot == null) {
        const listed = listWindowItemNames(first);
        logger.warn(`[bot #${this.id}] gold_ingot not found in /dm window`);
        return {
          ok: false,
          reason: 'fail',
          error: `золотой слиток не найден\n${listed}`,
        };
      }

      logger.info(`[bot #${this.id}] click gold_ingot slot #${goldSlot}`);
      void this.notify(`🪙 [#${this.id}] Жму золотой слиток (слот <code>${goldSlot}</code>)...`);

      const second = await this.waitForWindow(timeoutMs, async () => {
        // left click, normal mode
        await bot.clickWindow(goldSlot, 0, 0);
      }, { ignoreCurrent: true });

      await sleep(700);
      const win = bot.currentWindow ?? second;
      const text = formatWindowDumpChunks(win, this.id, {
        header: `🗂 [#${this.id}] После /dm → клик по золотому слитку`,
        dmOrders: true,
        withLore: true,
      }).join('\n\n---\n\n');

      return { ok: true, text };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === 'timeout') return { ok: false, reason: 'timeout' };
      logger.error(`[bot #${this.id}] runDm failed`, error);
      return { ok: false, reason: 'fail', error: msg };
    }
  }

  /** Ждёт открытия GUI. Если ignoreCurrent — игнорит уже открытое окно до нового. */
  private waitForWindow(
    timeoutMs: number,
    trigger: () => void | Promise<void>,
    opts?: { ignoreCurrent?: boolean },
  ): Promise<import('prismarine-windows').Window> {
    const bot = this.bot!;
    const prevId = opts?.ignoreCurrent ? (bot.currentWindow as any)?.id : null;

    return new Promise((resolve, reject) => {
      let settled = false;

      const settleOk = (window: import('prismarine-windows').Window, via: string) => {
        if (settled) return;
        if (opts?.ignoreCurrent && (window as any)?.id === prevId) return;
        settled = true;
        cleanup();
        logger.info(`[bot #${this.id}] window opened via ${via}`);
        resolve(window);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        const cur = bot.currentWindow;
        if (cur && (!opts?.ignoreCurrent || (cur as any).id !== prevId)) {
          settleOk(cur, 'currentWindow-timeout');
          return;
        }
        settled = true;
        cleanup();
        logger.warn(`[bot #${this.id}] window timeout`);
        reject(new Error('timeout'));
      }, timeoutMs);

      const finish = async (window: import('prismarine-windows').Window, via: string) => {
        await sleep(500);
        if (settled) return;
        const w = bot.currentWindow ?? window;
        settleOk(w, via);
      };

      const onOpen = (window: import('prismarine-windows').Window) => {
        void finish(window, 'windowOpen');
      };

      const onPacket = () => {
        if (!bot.currentWindow) return;
        if (opts?.ignoreCurrent && (bot.currentWindow as any).id === prevId) return;
        void finish(bot.currentWindow, 'open_window packet');
      };

      const cleanup = () => {
        clearTimeout(timer);
        bot.removeListener('windowOpen', onOpen);
        bot._client.removeListener('open_window', onPacket);
        bot._client.removeListener('open_screen', onPacket);
      };

      bot.on('windowOpen', onOpen);
      bot._client.on('open_window', onPacket);
      bot._client.on('open_screen', onPacket);

      void Promise.resolve(trigger()).catch((err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });
    });
  }

  /** Ждём следующий spawn (телепорт на режим) или таймаут. */
  private waitNextSpawn(timeoutMs: number): Promise<boolean> {
    const bot = this.bot;
    if (!bot) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        bot.removeListener('spawn', onSpawn);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const onSpawn = () => finish(true);
      bot.once('spawn', onSpawn);
    });
  }

  /** Хаб+капча готовы → /an305 → spawn → /dm. */
  private tryScheduleAn305() {
    if (this.autoDmDone || this.stopped) return;
    if (!this.isSpawned || !this.isActive) return;
    if (captchaEnabled() && !this.captchaSolved) {
      logger.info(`[bot #${this.id}] wait captcha before /an305`);
      return;
    }
    if (!this.hubReady) {
      logger.info(`[bot #${this.id}] wait hub before /an305`);
      return;
    }

    this.autoDmDone = true;
    logger.info(`[bot #${this.id}] schedule /an305 in 2s (hub ready)`);
    setTimeout(() => {
      if (this.stopped || !this.isActive || !this.isSpawned) return;
      void this.runAn305ThenDm();
    }, 2_000);
  }

  /** Заход на режим /an305, ждём телепорт, затем /dm + дамп окна. */
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

    const chatBuf: string[] = [];
    const onChat = (msg: string) => {
      const line = String(msg ?? '').trim();
      if (!line) return;
      chatBuf.push(line);
      logger.info(`[bot #${this.id}] chat: ${line.slice(0, 160)}`);
    };
    bot.on('messagestr', onChat);

    const gotSpawn = await this.waitNextSpawn(20_000);
    logger.info(`[bot #${this.id}] after /an305 spawn=${gotSpawn}`);

    if (!gotSpawn) {
      bot.off('messagestr', onChat);
      const hint = chatBuf.slice(-5).map(escapeHtml).join('\n') || 'нет ответа сервера';
      void this.notify(
        `❌ [#${this.id}] Не зашёл на /an305 (нет spawn).\n`
        + `Чат:\n<code>${hint.slice(0, 800)}</code>`,
      );
      return;
    }

    await sleep(2_500);
    if (this.stopped || !this.isActive) {
      bot.off('messagestr', onChat);
      return;
    }

    void this.notify(`📨 [#${this.id}] На /an305 — пишу <code>/dm</code>...`);
    const result = await this.runDm();
    bot.off('messagestr', onChat);

    if (result.ok) {
      void this.notify(result.text);
      return;
    }
    const hint = chatBuf.slice(-8).map(escapeHtml).join('\n') || '—';
    if (result.reason === 'timeout') {
      void this.notify(
        `⏰ [#${this.id}] /dm: окно не открылось.\nЧат:\n<code>${hint.slice(0, 800)}</code>`,
      );
      return;
    }
    void this.notify(
      `❌ [#${this.id}] /dm ошибка:\n<code>${escapeHtml((result.error ?? result.reason).slice(0, 800))}</code>`,
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
      void this.notify(`⏰ [#${this.id}] /dm: окно не открылось`);
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
      // без капчи можно сразу планировать режим
      if (!captchaEnabled()) this.captchaSolved = true;
      this.tryScheduleAn305();
    });

    bot.on('messagestr', (msg) => {
      const textMsg = String(msg ?? '');
      const low = textMsg.toLowerCase();
      if (
        low.includes('успешно')
        || low.includes('авторизован')
        || low.includes('добро пожаловать')
      ) {
        if (!this.serverAuthOk) {
          this.serverAuthOk = true;
          logger.info(`[bot #${this.id}] server auth ok: ${textMsg.slice(0, 80)}`);
        }
      }

      // Хаб FunTime: можно писать /an*
      if (
        !this.hubReady
        && (
          /социальн/i.test(textMsg)
          || /\/links/i.test(textMsg)
          || /выберите режим/i.test(textMsg)
          || /компас/i.test(textMsg)
          || /анархи/i.test(textMsg)
        )
      ) {
        this.hubReady = true;
        logger.info(`[bot #${this.id}] hub ready: ${textMsg.slice(0, 100)}`);
        this.tryScheduleAn305();
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
