import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CLICKER_CPS, clampCps } from '../config.js';
import type { BotRecord, ProxyConfig } from '../handlers/types.js';

const DATA_DIR = path.resolve('data');
const DB_PATH = path.join(DATA_DIR, 'bots.db');

export class BotDatabase {
  private db: Database.Database;

  constructor(dbPath = DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    // DELETE: все данные в bots.db (без -wal/-shm). GUI/SFTP не «пустые», пока процесс жив.
    // При апгрейде со старого WAL SQLite сам сделает checkpoint при смене режима.
    this.db.pragma('journal_mode = DELETE');
    this.init();
  }

  /** Checkpoint (если был WAL) и закрытие — вызывать на SIGTERM/SIGINT. */
  close() {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // не WAL или уже закрыто — ок
    }
    this.db.close();
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
        clicker_cps INTEGER NOT NULL DEFAULT 10,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Миграция для уже существующих БД
    const cols = this.db.prepare(`PRAGMA table_info(bots)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'clicker_cps')) {
      this.db.exec(`ALTER TABLE bots ADD COLUMN clicker_cps INTEGER NOT NULL DEFAULT 10`);
    }
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
    clickerCps?: number;
  }): BotRecord {
    const result = this.db
      .prepare(
        `INSERT INTO bots (label, email, password, proxy_host, proxy_port, proxy_user, proxy_pass, reconnect, clicker_cps)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        input.label?.trim() || input.email.split('@')[0] || 'bot',
        input.email.trim(),
        input.password?.trim() || '',
        input.proxy?.host ?? '',
        input.proxy?.port ?? 0,
        input.proxy?.user ?? '',
        input.proxy?.pass ?? '',
        clampCps(input.clickerCps ?? DEFAULT_CLICKER_CPS),
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
      clickerCps: number;
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
          reconnect = ?,
          clicker_cps = ?
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
        clampCps(patch.clickerCps ?? current.clickerCps),
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
    clickerCps: clampCps(Number(row.clicker_cps ?? DEFAULT_CLICKER_CPS)),
    createdAt: row.created_at,
  };
}

export const db = new BotDatabase();
