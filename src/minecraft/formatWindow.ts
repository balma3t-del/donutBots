import type { Window } from 'prismarine-windows';
import type { Item } from 'prismarine-item';
import fs from 'node:fs';
import path from 'node:path';

const TG_SAFE = 3500;

/** Разворачивает prismarine-nbt {type,value} и собирает chat text. */
export function stripMinecraftText(value: unknown): string {
  return flattenText(value).replace(/§[0-9a-fk-or]/gi, '').replace(/\s+/g, ' ').trim();
}

function flattenText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'object') return String(value);

  const obj = value as Record<string, any>;

  if (typeof obj.type === 'string' && 'value' in obj) {
    if (obj.type === 'list') {
      const inner = obj.value;
      const items = Array.isArray(inner?.value) ? inner.value : Array.isArray(inner) ? inner : [];
      return items.map(flattenText).join('');
    }
    return flattenText(obj.value);
  }

  let out = '';
  if (obj.text != null) out += flattenText(obj.text);
  if (obj.extra != null) out += flattenText(obj.extra);
  if (obj.translate != null) {
    out += flattenText(obj.translate);
    if (obj.with != null) out += ' ' + flattenText(obj.with);
  }
  return out;
}

function normalizeLoreLines(raw: unknown): string[] {
  if (raw == null) return [];

  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'object') {
    const obj = raw as Record<string, any>;
    if (typeof obj.type === 'string' && 'value' in obj) {
      return normalizeLoreLines(obj.value);
    }
    if (Array.isArray(obj.lines)) list = obj.lines;
    else if (Array.isArray(obj.value)) list = obj.value;
    else if (obj.value?.value && Array.isArray(obj.value.value)) list = obj.value.value;
    else if (Array.isArray(obj.extra)) list = [obj];
    else list = [raw];
  } else {
    list = [raw];
  }

  return list
    .map((line) => stripMinecraftText(line))
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function itemLore(item: Item): string[] {
  const anyItem = item as any;
  const fromGetter = normalizeLoreLines(anyItem.lore);
  if (fromGetter.length) return fromGetter;

  const comp = anyItem.componentMap?.get?.('lore')?.data
    ?? anyItem.components?.find?.((c: { type?: string }) => c.type === 'lore')?.data;
  return normalizeLoreLines(comp);
}

export type PriceRatio = {
  /** Цена в ⚡ (биржа) */
  price: string | null;
  /** Курс / соотношение: монет за 1⚡ */
  ratio: string | null;
  /** Сумма монет в заказе */
  coins: string | null;
  lore: string[];
};

/** Минимальный курс ($ за 1⚡) для TG-оповещения. */
export const DM_MIN_RATIO_ALERT = 800_000;

/** «$825,000 за 1⚡» → 825000 */
export function parseRatioAmount(ratio: string | null | undefined): number | null {
  if (!ratio) return null;
  const m = ratio.replace(/\s/g, '').match(/(\d[\d.,]*)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function isHighRatioLot(ratio: string | null | undefined, min = DM_MIN_RATIO_ALERT): boolean {
  const n = parseRatioAmount(ratio);
  return n != null && n > min;
}

/** FunTime /dm lore: «Цена: 1000⚡», «Курс: $800,000 за 1⚡», «Монет: $800,000,000». */
export function extractPriceAndRatio(lore: string[]): PriceRatio {
  let price: string | null = null;
  let ratio: string | null = null;
  let coins: string | null = null;

  for (const line of lore) {
    const priceM = line.match(/Цена\s*:\s*(.+)$/i);
    if (priceM && !price) price = priceM[1].trim();

    const ratioM = line.match(/Курс\s*:\s*(.+)$/i)
      || line.match(/Соотношен\w*\s*:\s*(.+)$/i);
    if (ratioM && !ratio) ratio = ratioM[1].trim();

    const coinsM = line.match(/Монет\w*\s*:\s*(.+)$/i);
    if (coinsM && !coins) coins = coinsM[1].trim();
  }

  // fallback: "$800,000 за 1⚡"
  if (!ratio) {
    for (const line of lore) {
      const m = line.match(/\$?\s*[\d,.\s]+\s+за\s+1\s*⚡?/i);
      if (m) {
        ratio = m[0].trim();
        break;
      }
    }
  }

  return { price, ratio, coins, lore };
}

function itemTitle(item: Item): string {
  const custom = item.customName ? stripMinecraftText(item.customName) : '';
  const display = stripMinecraftText(item.displayName) || item.name || 'unknown';
  let title = (custom || display).replace(/\s+/g, ' ').trim();
  if (title.length > 100) title = `${title.slice(0, 97)}...`;
  return title;
}

/** Конец контейнера GUI (начало инвентаря игрока). */
function containerEnd(window: Window): number {
  const inv = (window as { inventoryStart?: number }).inventoryStart;
  if (typeof inv === 'number' && inv > 0) return inv;
  return Math.max(0, (window.slots?.length ?? 0) - 36);
}

function looksLikeRefreshControl(title: string, lore: string, name: string): boolean {
  const blob = `${title} ${lore} ${name}`.toLowerCase();
  return (
    blob.includes('обнов')
    || blob.includes('refresh')
    || blob.includes('reload')
    || blob.includes('перезагруз')
    || blob.includes('актуализ')
  );
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

/** Кнопка обновления страницы ДонМаркета. */
export function findDmRefreshSlot(window: Window): number | null {
  const slots = window.slots ?? [];
  const end = containerEnd(window);

  // 1) явное имя/лор «обновить»
  for (let i = 0; i < end; i++) {
    const item = slots[i];
    if (!item) continue;
    const title = itemTitle(item);
    const lore = itemLore(item).join(' ');
    const name = item.name || '';
    // лоты тоже могут содержать «обнов» в редких случаях — пропускаем с ценой
    const parsed = extractPriceAndRatio(itemLore(item));
    if (parsed.price || parsed.ratio) continue;
    if (looksLikeRefreshControl(title, lore, name)) return i;
  }

  // 2) типичные иконки нижней панели без цены, с намёком в title/lore
  for (let i = 0; i < end; i++) {
    const item = slots[i];
    if (!item) continue;
    const parsed = extractPriceAndRatio(itemLore(item));
    if (parsed.price || parsed.ratio) continue;
    const name = (item.name || '').toLowerCase();
    const title = itemTitle(item).toLowerCase();
    const lore = itemLore(item).join(' ').toLowerCase();
    const iconHint =
      name === 'hopper'
      || name === 'sunflower'
      || name === 'clock'
      || name === 'lime_dye'
      || name === 'green_dye'
      || name === 'emerald'
      || name.includes('arrow')
      || name === 'nether_star'
      || name === 'structure_void'
      || name === 'command_block'
      || name === 'repeating_command_block'
      || name === 'knowledge_book'
      || name === 'writable_book'
      || name === 'comparator'
      || name === 'redstone';
    if (!iconHint) continue;
    if (looksLikeRefreshControl(title, lore, name)) return i;
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

/** Дамп заказов /dm с курсом > 800к: название + цена + соотношение. */
export function formatDmOrdersDump(window: Window, botId: number): string[] {
  const title = stripMinecraftText((window as any).title) || 'ДонМаркет';
  const slots = window.slots ?? [];
  const end = containerEnd(window);
  const refreshSlot = findDmRefreshSlot(window);

  const debug: Array<{
    slot: number;
    name: string;
    title: string;
    lore: string[];
    price: string | null;
    ratio: string | null;
    ratioNum: number | null;
    coins: string | null;
  }> = [];
  const lines: string[] = [];

  for (let i = 0; i < end; i++) {
    const item = slots[i];
    if (!item) continue;

    const lore = itemLore(item);
    const parsed = extractPriceAndRatio(lore);
    const name = itemTitle(item);
    const ratioNum = parseRatioAmount(parsed.ratio);
    debug.push({
      slot: i,
      name: item.name,
      title: name,
      lore,
      price: parsed.price,
      ratio: parsed.ratio,
      ratioNum,
      coins: parsed.coins,
    });

    // лот = есть курс выше порога
    if (!parsed.ratio || !isHighRatioLot(parsed.ratio)) continue;
    if (lines.length >= 10) continue;

    lines.push(
      `<b>${escapeHtml(name)}</b>`
      + `\n💰 Цена: <code>${escapeHtml(parsed.price ?? '—')}</code>`
      + `\n📉 Соотношение: <code>${escapeHtml(parsed.ratio)}</code>`
      + (parsed.coins ? `\n🪙 Монет: <code>${escapeHtml(parsed.coins)}</code>` : ''),
    );
  }

  try {
    const out = path.resolve('data', 'last-dm-orders.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(
      out,
      JSON.stringify(
        {
          title,
          inventoryStart: end,
          refreshSlot,
          slotsTotal: slots.length,
          minRatioAlert: DM_MIN_RATIO_ALERT,
          matched: lines.length,
          items: debug,
        },
        null,
        2,
      ),
    );
  } catch {
    // ignore
  }

  // нет лотов выше порога — без TG-сообщения
  if (lines.length === 0) return [];

  const header = [
    `🚨 [#${botId}] /dm · курс &gt; ${DM_MIN_RATIO_ALERT.toLocaleString('en-US')}`,
    `Окно: <b>${escapeHtml(title)}</b>`,
    `Лотов: <code>${lines.length}</code>`,
    '',
  ].join('\n');

  const chunks: string[] = [];
  let current = header;
  for (const block of lines) {
    if (current.length + block.length + 2 > TG_SAFE) {
      chunks.push(current.trimEnd());
      current = `🚨 [#${botId}] лоты &gt;800к (продолжение)\n\n${block}\n\n`;
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

  const title = stripMinecraftText((window as any).title) || 'без названия';
  const slots = window.slots ?? [];
  const header = [
    opts?.header ?? `🗂 [#${botId}] Окно`,
    `Заголовок: <b>${escapeHtml(title)}</b>`,
    `Слотов: <code>${slots.length}</code>`,
  ];

  const filled: string[] = [];
  for (let i = 0; i < slots.length; i++) {
    const item = slots[i];
    if (!item) continue;
    const lore = itemLore(item);
    const parsed = extractPriceAndRatio(lore);
    const name = itemTitle(item);
    let line = `#${i}: <b>${escapeHtml(name)}</b>`;
    if (parsed.price || parsed.ratio) {
      line += `\n   💰 ${escapeHtml(parsed.price ?? '—')} · 📉 ${escapeHtml(parsed.ratio ?? '—')}`;
    }
    filled.push(line);
  }

  if (!filled.length) return [`${header.join('\n')}\n\n(пусто)`];

  const chunks: string[] = [];
  let current = `${header.join('\n')}\n\nПредметы (${filled.length}):`;
  for (const line of filled) {
    if (current.length + line.length + 1 > TG_SAFE) {
      chunks.push(current);
      current = `🗂 [#${botId}] продолжение\n${line}`;
    } else current += `\n${line}`;
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
