import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
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
  PROFILES_FOLDER,
  PROXY_DOWN_RECONNECT_MS,
  RECONNECT_DELAY_MS,
  clampCps,
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
  clickerCps?: number;
  notify: NotifyFn;
};

function chatToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);

  const obj = value as Record<string, any>;

  // raw NBT: { type, value }
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
 * Классовая сессия mineflayer: лицензия (Microsoft), стабильный онлайн через reconnect.
 * Без капчи и без /login — сервер принимает игрока сразу после входа.
 */
export class BotSession extends EventEmitter {
  readonly id: number;
  email: string;
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

  /** Радиус «рядом» (блоки). */
  nearbyRadius = 64;
  /** Ники игроков в радиусе (lowercase → display name). */
  nearbyPlayers = new Map<string, string>();

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nearbyScanTimer: ReturnType<typeof setInterval> | null = null;
  private clickerTimer: ReturnType<typeof setInterval> | null = null;
  private authTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private joinSpinToken = 0;
  /** Последняя причина кика/дисконнекта для сообщения в TG. */
  private lastDisconnectReason: string | null = null;
  private disconnectNotified = false;
  private msaCodeSent = false;
  /** Подряд кики «already online» — сессия на прокси не отвалилась. */
  private alreadyOnlineStreak = 0;

  constructor(opts: BotSessionOptions) {
    super();
    this.id = opts.id;
    this.email = opts.email;
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
    this.lastDisconnectReason = null;
    this.disconnectNotified = false;
    this.msaCodeSent = false;
    this.inGameName = null;
    this.nearbyPlayers.clear();

    fs.mkdirSync(path.resolve(PROFILES_FOLDER), { recursive: true });

    // Парольный Microsoft-логин часто ломается (MFA / «try removing the password field»).
    // Всегда device-code + кэш токенов в profilesFolder.
    const timeoutMin = Math.round(AUTH_TIMEOUT_MS / 60_000);
    void this.notify(
      `🔄 [#${this.id}] Подключаюсь (${this.email})...\n`
      + `Ожидай код Microsoft в этом чате (если токен ещё не сохранён).\n`
      + `⏱ Таймаут: ${timeoutMin} мин. На сервере должен быть доступ к login.live.com / xboxlive.com.`,
    );

    this.armAuthTimeout();

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
        this.msaCodeSent = true;
        const code = data.user_code ?? '?';
        const uri = data.verification_uri ?? 'https://www.microsoft.com/link';
        const hint = data.message || `Открой ${uri} и введи код ${code}`;
        logger.info(`[bot #${this.id}] MSA code: ${code}`);
        void this.notify(
          `🔐 [#${this.id}] Microsoft auth\n`
          + `<code>${escapeHtml(hint)}</code>\n`
          + `Код: <code>${escapeHtml(code)}</code>\n`
          + `Ссылка: ${uri}\n\n`
          + `После ввода кода бот ждёт ответ Microsoft — это может занять до пары минут.\n`
          + `Если зависло: на сервере проверь исходящий HTTPS к Microsoft, или нажми «Отменить».`,
        );
      },
    };

    if (hasProxy(this.proxy)) {
      botOptions.connect = (client: Client) => this.createProxyConnection(client);
    }

    try {
      this.bot = mineflayer.createBot(botOptions as any);
      this.bindClientGuards();
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
    this.joinSpinToken += 1; // прервать плавный поворот
    this.clearAuthTimeout();
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

  /**
   * Медленный поворот на 360° look-пакетами с человеческим темпом
   * (не мгновенный snap yaw).
   */
  private async smoothSpin360() {
    const bot = this.bot;
    if (!bot?.entity || !this.isSpawned || this.stopped) return;

    const token = ++this.joinSpinToken;
    const startYaw = bot.entity.yaw;
    const basePitch = bot.entity.pitch;
    const duration = JOIN_SPIN_MS;
    // ~человеческий look rate: ~15–20 обновлений/сек, не каждый тик сервера пачкой
    const stepMs = 55 + Math.floor(Math.random() * 25); // 55–80ms
    const steps = Math.max(24, Math.round(duration / stepMs));
    // Случайное направление (по/против часовой)
    const dir = Math.random() < 0.5 ? 1 : -1;

    logger.info(`[bot #${this.id}] join spin start (${duration}ms, steps=${steps})`);

    for (let i = 1; i <= steps; i++) {
      if (token !== this.joinSpinToken || !this.bot?.entity || this.stopped || !this.isSpawned) {
        return;
      }

      const t = i / steps;
      // ease-in-out: медленнее в начале/конце, как у игрока
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const yaw = startYaw + dir * Math.PI * 2 * eased;
      // крошечный шум pitch — не «идеальная» ось бота
      const pitch = basePitch + Math.sin(t * Math.PI * 2) * 0.02;

      try {
        // force=true: мы сами задаём темп задержками; physics у нас выключен
        await this.bot.look(yaw, pitch, true);
      } catch {
        return;
      }

      const jitter = stepMs + Math.floor(Math.random() * 20) - 8;
      await sleep(Math.max(40, jitter));
    }

    // Вернуть pitch ближе к исходному
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
      const hint = this.msaCodeSent
        ? 'код был выдан, но вход не завершился (истёк / сеть сервера не достучалась до Microsoft)'
        : 'код Microsoft так и не пришёл (сеть сервера / firewall / блокировка login.live.com)';
      logger.warn(`[bot #${this.id}] auth timeout | ${hint}`);
      this.isAuthFailed = true;
      this.reconnect = false;
      void this.notify(
        `⏰ [#${this.id}] Таймаут авторизации\n${hint}\n`
        + `На VPS нужен исходящий HTTPS к Microsoft. Затем снова «Включить».`,
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

  /** Включить автокликер ПКМ (activate/deactivate предмета в руке). */
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

  /** Выключить автокликер. */
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

  /** Обновить CPS на лету (если кликер включён — перезапускает таймер). */
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

  /** Один клик ПКМ: use item → release. */
  private clickOnce() {
    const bot = this.bot;
    if (!bot || !this.isClickerOn || !this.isActive || !this.isSpawned) {
      this.stopClickerTimer();
      return;
    }

    try {
      bot.activateItem();
      // Короткий импульс «клика», не удержание
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
      this.clearAuthTimeout();
      this.isConnect = false;
      this.isActive = true;
      this.inGameName = bot.username;
      void this.notify(`✅ [#${this.id}] Онлайн как <b>${bot.username}</b>`);
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
      // Небольшая пауза после спавна — как игрок осматривается
      setTimeout(() => {
        void this.smoothSpin360();
      }, 800 + Math.floor(Math.random() * 700));
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

    bot.on('kicked', (reason) => {
      const text = chatToText(reason) || 'unknown kick';
      this.lastDisconnectReason = `kick: ${text}`;
      logger.warn(`[bot #${this.id}] kicked: ${text}`);
      this.notifyDisconnect(`🚪 [#${this.id}] Кикнут с сервера\n<code>${escapeHtml(text.slice(0, 500))}</code>`);
    });

    // Сырой пакет disconnect (часто приходит вместо/раньше kicked)
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
      this.joinSpinToken += 1;
      this.clearAuthTimeout();
      this.stopClicker(false);
      this.stopNearbyScan();
      this.isConnect = false;
      this.isActive = false;

      const endReason = reason?.trim() || 'no reason';
      const detail = this.lastDisconnectReason
        ? `${this.lastDisconnectReason}\nend: ${endReason}`
        : `end: ${endReason}`;
      logger.warn(`[bot #${this.id}] end | ${detail}`);

      // Если kicked уже уведомил — не дублируем, иначе шлём полный end
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

    const reasonText = this.lastDisconnectReason ?? '';
    const alreadyOnline = isAlreadyOnlineReason(reasonText);

    if (alreadyOnline) {
      this.alreadyOnlineStreak += 1;
      if (this.alreadyOnlineStreak >= ALREADY_ONLINE_MAX_STREAK) {
        this.reconnect = false;
        this.clear();
        void this.notify(
          `⛔ [#${this.id}] Стоп реконнекта: ${this.alreadyOnlineStreak}× «already online».\n`
          + `Прокси ещё держит сессию. Подожди 1–2 мин и нажми «Включить» вручную.\n`
          + `Также проверь, что аккаунт не запущен в другом месте.`,
        );
        return;
      }
    } else if (this.isSpawned || this.isActive) {
      // Успели поиграть — сбрасываем серию ghost-сессий
      this.alreadyOnlineStreak = 0;
    }

    let delay = RECONNECT_DELAY_MS;
    let delayNote = '';
    if (this.isProxyDown) {
      delay = PROXY_DOWN_RECONNECT_MS;
      delayNote = ' (прокси)';
    } else if (alreadyOnline) {
      // Прокси не сразу отпускает слот — 5с только усугубляет цикл
      delay = ALREADY_ONLINE_RECONNECT_MS * this.alreadyOnlineStreak;
      delayNote = ` (already online ×${this.alreadyOnlineStreak})`;
    } else if (/kick:|disconnect:/i.test(reasonText)) {
      // После любого кика даём прокси чуть отпустить сессию
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
    this.msaCodeSent = false;
    this.bot = null;
    // alreadyOnlineStreak специально НЕ сбрасываем здесь
  }
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
