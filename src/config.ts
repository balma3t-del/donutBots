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

if (ADMIN_IDS.length === 0) {
  console.warn('ADMIN_IDS is empty — nobody can use the panel');
}
