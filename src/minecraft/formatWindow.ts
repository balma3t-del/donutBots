import type { Window } from 'prismarine-windows';
import type { Item } from 'prismarine-item';

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
  const title = custom || display;
  const count = item.count > 1 ? ` ×${item.count}` : '';
  return `#${slot}: <b>${escapeHtml(title)}</b>${count} <code>${escapeHtml(item.name)}</code>`;
}

export function formatWindowDump(window: Window, botId: number): string {
  const title = stripMinecraftText((window as any).title) || 'без названия';
  const type = String((window as any).type ?? window.slots?.length ?? '?');
  const slots = window.slots ?? [];

  const lines: string[] = [
    `🗂 [#${botId}] Окно после <code>/dm</code>`,
    `Заголовок: <b>${escapeHtml(title)}</b>`,
    `Тип/id: <code>${escapeHtml(type)}</code>`,
    `Слотов: <code>${slots.length}</code>`,
    '',
  ];

  const filled: string[] = [];
  for (let i = 0; i < slots.length; i++) {
    const item = slots[i];
    if (!item) continue;
    filled.push(itemLine(i, item));
  }

  if (filled.length === 0) {
    lines.push('(пусто — слоты ещё не пришли или окно без предметов)');
  } else {
    lines.push(`Предметы (${filled.length}):`);
    // Telegram message limit ~4096; keep dump reasonable
    const max = 40;
    lines.push(...filled.slice(0, max));
    if (filled.length > max) lines.push(`…и ещё ${filled.length - max}`);
  }

  return lines.join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
