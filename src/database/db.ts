import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { BotRecord, ProxyConfig } from '../handlers/types.js';

const DATA_DIR = path.resolve('data');
const DB_PATH = path.join(DATA_DIR, 'bots.db');

export class BotDatabase {
  private db: Database.Database;

  constructor(dbPath = DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        password TEXT NOT NULL DEFAULT '',
        proxy_host TEXT NOT NULL DEFAULT '',
        proxy_port INTEGER NOT NULL DEFAULT 0,
        proxy_user TEXT NOT NULL DEFAULT '',
        proxy_pass TEXT NOT NULL DEFAULT '',
        reconnect INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  listBots(): BotRecord[] {
    const rows = this.db.prepare('SELECT * FROM bots ORDER BY id ASC').all() as any[];
    return rows.map(mapRow);
  }

  getBot(id: number): BotRecord | null {
    const row = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as any;
    return row ? mapRow(row) : null;
  }

  addBot(input: {
    label?: string;
    email: string;
    password?: string;
    proxy?: ProxyConfig | null;
  }): BotRecord {
    const result = this.db
      .prepare(
        `INSERT INTO bots (label, email, password, proxy_host, proxy_port, proxy_user, proxy_pass, reconnect)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        input.label?.trim() || input.email.split('@')[0] || 'bot',
        input.email.trim(),
        input.password?.trim() || '',
        input.proxy?.host ?? '',
        input.proxy?.port ?? 0,
        input.proxy?.user ?? '',
        input.proxy?.pass ?? '',
      );

    const bot = this.getBot(Number(result.lastInsertRowid));
    if (!bot) throw new Error('Failed to create bot');
    return bot;
  }

  updateBot(
    id: number,
    patch: Partial<{
      label: string;
      email: string;
      password: string;
      reconnect: boolean;
      proxy: ProxyConfig | null;
    }>,
  ): boolean {
    const current = this.getBot(id);
    if (!current) return false;

    const proxy = patch.proxy === undefined
      ? {
          host: current.proxyHost,
          port: current.proxyPort,
          user: current.proxyUser,
          pass: current.proxyPass,
        }
      : patch.proxy ?? { host: '', port: 0, user: '', pass: '' };

    const result = this.db
      .prepare(
        `UPDATE bots SET
          label = ?,
          email = ?,
          password = ?,
          proxy_host = ?,
          proxy_port = ?,
          proxy_user = ?,
          proxy_pass = ?,
          reconnect = ?
         WHERE id = ?`,
      )
      .run(
        patch.label ?? current.label,
        patch.email ?? current.email,
        patch.password ?? current.password,
        proxy.host,
        proxy.port,
        proxy.user,
        proxy.pass,
        (patch.reconnect ?? current.reconnect) ? 1 : 0,
        id,
      );

    return result.changes > 0;
  }

  deleteBot(id: number): boolean {
    const result = this.db.prepare('DELETE FROM bots WHERE id = ?').run(id);
    return result.changes > 0;
  }
}

function mapRow(row: any): BotRecord {
  return {
    id: row.id,
    label: row.label ?? '',
    email: row.email ?? '',
    password: row.password ?? '',
    proxyHost: row.proxy_host ?? '',
    proxyPort: Number(row.proxy_port ?? 0),
    proxyUser: row.proxy_user ?? '',
    proxyPass: row.proxy_pass ?? '',
    reconnect: Boolean(row.reconnect),
    createdAt: row.created_at,
  };
}

export const db = new BotDatabase();
