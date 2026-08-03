import 'dotenv/config';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const BOT_TOKEN = requireEnv('BOT_TOKEN');

export const ADMIN_IDS: number[] = (process.env.ADMIN_IDS ?? '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

export const isAdmin = (userId: number): boolean => ADMIN_IDS.includes(userId);

export const MC_HOST = process.env.MC_HOST?.trim() || 'localhost';
export const MC_PORT = Number(process.env.MC_PORT ?? 25565);
export const MC_VERSION = process.env.MC_VERSION?.trim() || '1.21.1';

export const PROFILES_FOLDER = process.env.PROFILES_FOLDER?.trim() || './data/profiles';

export const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS ?? 5000);
export const PROXY_DOWN_RECONNECT_MS = Number(process.env.PROXY_DOWN_RECONNECT_MS ?? 60_000);
/** Пауза после кика «already online» — прокси ещё держит сессию. */
export const ALREADY_ONLINE_RECONNECT_MS = Number(process.env.ALREADY_ONLINE_RECONNECT_MS ?? 60_000);
/** Сколько раз подряд «already online» — после этого стоп (ручной перезапуск). */
export const ALREADY_ONLINE_MAX_STREAK = Number(process.env.ALREADY_ONLINE_MAX_STREAK ?? 3);
/** Таймаут Microsoft auth / коннекта до spawn (мс). Device-code обычно ~15 мин. */
export const AUTH_TIMEOUT_MS = Number(process.env.AUTH_TIMEOUT_MS ?? 12 * 60_000);

/** CPS кликера ПКМ по умолчанию (1–20). */
export const DEFAULT_CLICKER_CPS = clampCps(Number(process.env.CLICKER_CPS ?? 10));

/** Длительность плавного поворота на 360° после входа (мс). */
export const JOIN_SPIN_MS = Math.max(2000, Number(process.env.JOIN_SPIN_MS ?? 6000));

export function clampCps(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.min(20, Math.max(1, Math.round(value)));
}

if (ADMIN_IDS.length === 0) {
  console.warn('ADMIN_IDS is empty — nobody can use the panel');
}
