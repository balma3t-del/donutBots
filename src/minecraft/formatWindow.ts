import type { Window } from 'prismarine-windows';
import type { Item } from 'prismarine-item';

const TG_SAFE = 3500;

function stripMinecraftText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    return value.replace(/§[0-9a-fk-or]/gi, '').trim();
  }
  if (typeof value !== 'object') return String(value);

  const obj = value as Record<string, any>;
  if (typeof obj.text === 'string') {
    let out = obj.text;
    if (Array.isArray(obj.extra)) out += obj.extra.map(stripMinecraftText).join('');
    return out.replace(/§[0-9a-fk-or]/gi, '').trim();
  }
  if (obj.translate) return String(obj.translate);
  if (obj.value != null) return stripMinecraftText(obj.value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function itemLine(slot: number, item: Item): string {
  const custom = item.customName ? stripMinecraftText(item.customName) : '';
  const display = stripMinecraftText(item.displayName) || item.name || 'unknown';
  // customName часто огромный JSON — режем
  let title = (custom || display).replace(/\s+/g, ' ').trim();
  if (title.length > 80) title = `${title.slice(0, 77)}...`;
  const count = item.count > 1 ? ` ×${item.count}` : '';
  return `#${slot}: <b>${escapeHtml(title)}</b>${count} <code>${escapeHtml(item.name)}</code>`;
}

/** Один или несколько кусков под лимит Telegram. */
export function formatWindowDumpChunks(window: Window, botId: number): string[] {
  const titleRaw = stripMinecraftText((window as any).title) || 'без названия';
  const title = titleRaw.length > 120 ? `${titleRaw.slice(0, 117)}...` : titleRaw;
  const type = String((window as any).type ?? window.slots?.length ?? '?');
  const slots = window.slots ?? [];

  const header = [
    `🗂 [#${botId}] Окно после <code>/an305</code> → <code>/dm</code>`,
    `Заголовок: <b>${escapeHtml(title)}</b>`,
    `Тип/id: <code>${escapeHtml(type)}</code>`,
    `Слотов: <code>${slots.length}</code>`,
  ];

  const filled: string[] = [];
  for (let i = 0; i < slots.length; i++) {
    const item = slots[i];
    if (!item) continue;
    filled.push(itemLine(i, item));
  }

  if (filled.length === 0) {
    return [`${header.join('\n')}\n\n(пусто — слоты ещё не пришли или окно без предметов)`];
  }

  const chunks: string[] = [];
  let current = `${header.join('\n')}\n\nПредметы (${filled.length}):`;

  for (const line of filled) {
    if (current.length + line.length + 1 > TG_SAFE) {
      chunks.push(current);
      current = `🗂 [#${botId}] окно (продолжение)\n${line}`;
    } else {
      current += `\n${line}`;
    }
  }
  chunks.push(current);
  return chunks;
}

export function formatWindowDump(window: Window, botId: number): string {
  return formatWindowDumpChunks(window, botId).join('\n\n');
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
