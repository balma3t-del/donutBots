import type { Window } from 'prismarine-windows';
import type { Item } from 'prismarine-item';

const TG_SAFE = 3500;

export function stripMinecraftText(value: unknown): string {
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
  if (Array.isArray(obj.extra)) return obj.extra.map(stripMinecraftText).join('');
  if (obj.translate) return String(obj.translate);
  if (obj.value != null) return stripMinecraftText(obj.value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function itemLore(item: Item): string[] {
  const lore = (item as any).lore;
  if (!Array.isArray(lore)) return [];
  return lore
    .map((line: unknown) => stripMinecraftText(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 12);
}

function itemLine(slot: number, item: Item, withLore: boolean): string {
  const custom = item.customName ? stripMinecraftText(item.customName) : '';
  const display = stripMinecraftText(item.displayName) || item.name || 'unknown';
  let title = (custom || display).replace(/\s+/g, ' ').trim();
  if (title.length > 100) title = `${title.slice(0, 97)}...`;
  const count = item.count > 1 ? ` ×${item.count}` : '';
  let line = `#${slot}: <b>${escapeHtml(title)}</b>${count} <code>${escapeHtml(item.name)}</code>`;
  if (withLore) {
    const lore = itemLore(item);
    if (lore.length) {
      line += `\n   ${lore.map((l) => escapeHtml(l)).join(' · ')}`;
    }
  }
  return line;
}

export function findGoldIngotSlot(window: Window): number | null {
  const slots = window.slots ?? [];
  for (let i = 0; i < slots.length; i++) {
    const item = slots[i];
    if (!item) continue;
    const name = (item.name || '').toLowerCase();
    const custom = stripMinecraftText(item.customName).toLowerCase();
    const display = stripMinecraftText(item.displayName).toLowerCase();
    if (
      name === 'gold_ingot'
      || name.includes('gold_ingot')
      || custom.includes('золот')
      || display.includes('золот')
      || display.includes('gold ingot')
    ) {
      return i;
    }
  }
  return null;
}

/** Список слотов для отладки, если слиток не найден. */
export function listWindowItemNames(window: Window): string {
  const slots = window.slots ?? [];
  const lines: string[] = [];
  for (let i = 0; i < slots.length; i++) {
    const item = slots[i];
    if (!item) continue;
    const title = stripMinecraftText(item.customName) || stripMinecraftText(item.displayName) || item.name;
    lines.push(`#${i} ${item.name} | ${title}`.slice(0, 120));
  }
  return lines.slice(0, 30).join('\n') || '(пусто)';
}

export function formatWindowDumpChunks(
  window: Window,
  botId: number,
  opts?: { header?: string; withLore?: boolean },
): string[] {
  const titleRaw = stripMinecraftText((window as any).title) || 'без названия';
  const title = titleRaw.length > 120 ? `${titleRaw.slice(0, 117)}...` : titleRaw;
  const type = String((window as any).type ?? window.slots?.length ?? '?');
  const slots = window.slots ?? [];
  const withLore = opts?.withLore ?? true;

  const header = [
    opts?.header ?? `🗂 [#${botId}] Окно`,
    `Заголовок: <b>${escapeHtml(title)}</b>`,
    `Тип/id: <code>${escapeHtml(type)}</code>`,
    `Слотов: <code>${slots.length}</code>`,
  ];

  const filled: string[] = [];
  for (let i = 0; i < slots.length; i++) {
    const item = slots[i];
    if (!item) continue;
    filled.push(itemLine(i, item, withLore));
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

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
