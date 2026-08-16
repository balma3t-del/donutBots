import 'dotenv/config';
import { bot } from './bot.js';
import { ADMIN_IDS, MC_HOST, MC_PORT, MC_VERSION } from './config.js';
import { db } from './database/db.js';
import { registerPanel } from './handlers/panel.js';
import { SessionManager } from './minecraft/SessionManager.js';
import { logger } from './utils/logger.js';

async function notifyAdmins(text: string) {
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.api.sendMessage(adminId, text, { parse_mode: 'HTML' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`notify admin ${adminId} failed: ${msg}`);
    }
  }
}

const manager = new SessionManager(notifyAdmins);

registerPanel(bot, manager);

bot.catch((err) => {
  const e = err.error as { error_code?: number; description?: string; message?: string };
  const desc = e?.description || e?.message || String(err.error);
  if (e?.error_code === 409 || desc.includes('Conflict')) {
    logger.error(
      'TG 409 Conflict: уже крутится другой инстанс с этим BOT_TOKEN. '
      + 'Оставь только один (сервер ИЛИ локальный Docker), иначе кики/алерты в TG не доходят.',
    );
    return;
  }
  logger.error(`update ${err.ctx.update.update_id}`, err.error);
});

async function main() {
  logger.info(`MC target ${MC_HOST}:${MC_PORT} (${MC_VERSION})`);
  logger.info(`Admins: ${ADMIN_IDS.join(', ') || 'none'}`);

  const gracefulExit = () => {
    manager.shutdownAll();
    try {
      db.close();
    } catch {
      // already closed
    }
    process.exit(0);
  };
  process.on('SIGINT', gracefulExit);
  process.on('SIGTERM', gracefulExit);

  // drop pending updates — меньше гонок при рестарте
  await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => {});

  await bot.start({
    onStart: async (info) => {
      logger.info(`TG bot @${info.username} started`);
      if (process.env.AUTO_TURN_ON === '1') {
        const bots = db.listBots();
        logger.info(`AUTO_TURN_ON: starting ${bots.length} bot(s)`);
        for (const record of bots) {
          const result = await manager.turnOn(record.id);
          logger.info(`AUTO_TURN_ON #${record.id} → ${result}`);
        }
      }
    },
  });
}

main().catch((error) => {
  const desc = String((error as any)?.description ?? (error as any)?.message ?? error);
  if (desc.includes('409') || desc.includes('Conflict')) {
    logger.error(
      'Не удалось стартовать TG: 409 Conflict. Останови все другие копии этого BOT_TOKEN и перезапусти.',
    );
  } else {
    logger.error('fatal', error);
  }
  process.exit(1);
});
