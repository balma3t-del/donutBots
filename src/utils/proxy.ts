import { SocksClient } from 'socks';
import type { ProxyConfig } from '../handlers/types.js';
import { MC_HOST, MC_PORT } from '../config.js';

export function parseProxy(raw: string): ProxyConfig | null {
  const text = raw.trim();
  if (text.includes('@')) {
    const [cred, hostPort] = text.split('@');
    const [user, pass] = cred.split(':');
    const [host, portStr] = hostPort.split(':');
    const port = Number(portStr);
    if (!host || !Number.isFinite(port)) return null;
    return { host, port, user: user ?? '', pass: pass ?? '' };
  }

  const parts = text.split(':');
  if (parts.length < 2) return null;
  const [host, portStr, user = '', pass = ''] = parts;
  const port = Number(portStr);
  if (!host || !Number.isFinite(port)) return null;
  return { host, port, user, pass };
}

export function formatProxy(proxy: ProxyConfig | null | undefined): string {
  if (!proxy?.host) return 'не задан';
  const auth = proxy.user ? `${proxy.user}:***@` : '';
  return `${auth}${proxy.host}:${proxy.port}`;
}

export function hasProxy(proxy: ProxyConfig | null | undefined): boolean {
  return Boolean(proxy?.host && proxy.port);
}

/** Проверка SOCKS5: можем ли достучаться до MC-сервера через прокси. */
export async function checkProxyWorking(proxy: ProxyConfig, timeoutMs = 5000): Promise<boolean> {
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
      timeout: timeoutMs,
    });
    connection.socket.destroy();
    return true;
  } catch {
    return false;
  }
}
