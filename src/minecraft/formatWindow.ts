import type { Window } from 'prismarine-windows';
import type { Item } from 'prismarine-item';
import fs from 'node:fs';
import path from 'node:path';

const TG_SAFE = 3500;

export function stripMinecraftText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    return value.replace(/§[0-9a-fk-or]/gi, '').trim();
  }
  if (typeof value !== 'object') return String(value);

  const obj = value as Record<string, any>;

  // NBT-обёртки
  if (obj.type === 'string' && 'value' in obj) return stripMinecraftText(obj.value);
  if (obj.type === 'list' && obj.value?.value) {
    const items = obj.value.value;
    if (Array.isArray(items)) return items.map(stripMinecraftText).join('');
  }
  if (obj.type === 'compound' && obj.value) return stripMinecraftText(obj.value);

  if (typeof obj.text === 'string') {
    let out = obj.text;
    if (Array.isArray(obj.extra)) out += obj.extra.map(stripMinecraftText).join('');
    return out.replace(/§[0-9a-fk-or]/gi, '').trim();
  }
  if (Array.isArray(obj.extra)) return obj.extra.map(stripMinecraftText).join('');
  if (obj.translate) {
    const withArgs = Array.isArray(obj.with)
      ? obj.with.map(stripMinecraftText).join(' ')
      : '';
    return `${obj.translate}${withArgs ? ` ${withArgs}` : ''}`.replace(/§[0-9a-fk-or]/gi, '').trim();
  }
  if (Array.isArray(obj)) return obj.map(stripMinecraftText).join('');
  if (obj.value != null) return stripMinecraftText(obj.value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeLoreLines(raw: unknown): string[] {
  if (raw == null) return [];

  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'object') {
    const obj = raw as Record<string, any>;
    if (Array.isArray(obj.lines)) list = obj.lines;
    else if (Array.isArray(obj.value)) list = obj.value;
    else if (obj.value?.value && Array.isArray(obj.value.value)) list = obj.value.value;
    else if (Array.isArray(obj.extra)) list = obj.extra;
    else list = [raw];
  } else {
    list = [raw];
  }

  return list
    .map((line) => stripMinecraftText(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function itemLore(item: Item): string[] {
  const anyItem = item as any;
  const fromGetter = normalizeLoreLines(anyItem.lore);
  if (fromGetter.length) return fromGetter;

  // fallback components map
  const comp = anyItem.componentMap?.get?.('lore')?.data ?? anyItem.components?.find?.(
    (c: { type?: string }) => c.type === 'lore',
  )?.data;
  return normalizeLoreLines(comp);
}

export type PriceRatio = {
  price: string | null;
  ratio: string | null;
  lore: string[];
};

/** Достаёт цену и соотношение/курс из lore FunTime /dm. */
export function extractPriceAndRatio(lore: string[]): PriceRatio {
  let price: string | null = null;
  let ratio: string | null = null;

  for (const line of lore) {
    const low = line.toLowerCase();

    if (!price) {
      const m =
        line.match(/(?:цена|стоимость|запрос|сумма|к оплате)\s*[:：]?\s*(.+)$/i)
        || (low.includes('монет') && !low.includes('за 1')
          ? line.match(/([\d\s.,]+(?:[кkмmбb]+)?(?:\s*монет\w*)?)/i)
          : null);
      if (m?.[1]) price = m[1].trim();
    }

    if (!ratio) {
      const labeled = line.match(/(?:соотношен\w*|курс|кэф|коэфф?\w*)\s*[:：]?\s*(.+)$/i);
      if (labeled?.[1]) {
        ratio = labeled[1].trim();
      } else {
        const compact = line.match(/([\d\s.,]+)\s*(?:за|\/)\s*1\s*[↯₴₽р]?/i);
        if (compact) ratio = compact[0].trim();
      }
    }
  }

  // иногда цена — просто крупное число в lore без слова «цена»
  if (!price) {
    for (const line of lore) {
      if (/соотношен|курс|кэф|за\s*1/i.test(line)) continue;
      const m = line.match(/^([\d\s]{3,}(?:[.,]\d+)?(?:\s*[кkмmбb]{1,3})?)$/i);
      if (m) {
        price = m[1].trim();
        break;
      }
    }
  }

  return { price, ratio, lore };
}

function itemTitle(item: Item): string {
  const custom = item.customName ? stripMinecraftText(item.customName) : '';
  const display = stripMinecraftText(item.displayName) || item.name || 'unknown';
  let title = (custom || display).replace(/\s+/g, ' ').trim();
  if (title.length > 100) title = `${title.slice(0, 97)}...`;
  return title;
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

export function listWindowItemNames(window: Window): string {
  const slots = window.slots ?? [];
  const lines: string[] = [];
  for (let i = 0; i < slots.length; i++) {
    const item = slots[i];
    if (!item) continue;
    lines.push(`#${i} ${item.name} | ${itemTitle(item)}`.slice(0, 120));
  }
  return lines.slice(0, 30).join('\n') || '(пусто)';
}

/** Дамп заказов /dm: только название, цена, соотношение. */
export function formatDmOrdersDump(window: Window, botId: number): string[] {
  const titleRaw = stripMinecraftText((window as any).title) || 'без названия';
  const title = titleRaw.length > 120 ? `${titleRaw.slice(0, 117)}...` : titleRaw;
  const slots = window.slots ?? [];

  const debug: Array<{ slot: number; name: string; title: string; lore: string[]; price: string | null; ratio: string | null }> = [];
  const lines: string[] = [];

  for (let i = 0; i < slots.length; i++) {
    const item = slots[i];
    if (!item) continue;
    // обычно заказы в верхних слотах GUI, инвентарь игрока снизу — отсекаем player inventory
    // chest/generic: первые N слотов; если слотов много, берём всё кроме последних 36 (инвентарь)
    const playerInvStart = Math.max(0, slots.length - 36);
    if (i >= playerInvStart) continue;

    const lore = itemLore(item);
    const { price, ratio } = extractPriceAndRatio(lore);
    const name = itemTitle(item);
    debug.push({ slot: i, name: item.name, title: name, lore, price, ratio });

    // пропускаем чисто декоративные пустые/служебные без цены и соотношения
    if (!price && !ratio && lore.length === 0) continue;

    lines.push(
      `<b>${escapeHtml(name)}</b>`
      + `\n💰 Цена: <code>${escapeHtml(price ?? '—')}</code>`
      + `\n📉 Соотношение: <code>${escapeHtml(ratio ?? '—')}</code>`,
    );
  }

  try {
    const out = path.resolve('data', 'last-dm-orders.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ title: titleRaw, items: debug }, null, 2));
  } catch {
    // ignore
  }

  const header = [
    `🗂 [#${botId}] /dm → золотой слиток → заказы`,
    `Окно: <b>${escapeHtml(title)}</b>`,
    `Лотов: <code>${lines.length}</code>`,
    '',
  ].join('\n');

  if (lines.length === 0) {
    return [
      `${header}(лоты не найдены — смотри data/last-dm-orders.json)\n`
      + `Слоты:\n<code>${escapeHtml(listWindowItemNames(window).slice(0, 800))}</code>`,
    ];
  }

  const chunks: string[] = [];
  let current = header;

  for (const block of lines) {
    if (current.length + block.length + 2 > TG_SAFE) {
      chunks.push(current.trimEnd());
      current = `🗂 [#${botId}] заказы (продолжение)\n\n${block}\n\n`;
    } else {
      current += `${block}\n\n`;
    }
  }
  chunks.push(current.trimEnd());
  return chunks;
}

export function formatWindowDumpChunks(
  window: Window,
  botId: number,
  opts?: { header?: string; withLore?: boolean; dmOrders?: boolean },
): string[] {
  if (opts?.dmOrders) return formatDmOrdersDump(window, botId);

  const titleRaw = stripMinecraftText((window as any).title) || 'без названия';
  const title = titleRaw.length > 120 ? `${titleRaw.slice(0, 117)}...` : titleRaw;
  const type = String((window as any).type ?? window.slots?.length ?? '?');
  const slots = window.slots ?? [];

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
    const lore = itemLore(item);
    const { price, ratio } = extractPriceAndRatio(lore);
    const name = itemTitle(item);
    const count = item.count > 1 ? ` ×${item.count}` : '';
    let line = `#${i}: <b>${escapeHtml(name)}</b>${count}`;
    if (price || ratio) {
      line += `\n   💰 ${escapeHtml(price ?? '—')} · 📉 ${escapeHtml(ratio ?? '—')}`;
    } else if (opts?.withLore !== false && lore.length) {
      line += `\n   ${lore.slice(0, 4).map(escapeHtml).join(' · ')}`;
    }
    filled.push(line);
  }

  if (filled.length === 0) {
    return [`${header.join('\n')}\n\n(пусто)`];
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
