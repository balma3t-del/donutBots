import 'dotenv/config';
import { bot } from './bot.js';
import { ADMIN_IDS, MC_HOST, MC_PORT, MC_VERSION } from './config.js';
import { registerPanel } from './handlers/panel.js';
import { SessionManager } from './minecraft/SessionManager.js';
import { logger } from './utils/logger.js';

async function notifyAdmins(text: string) {
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.api.sendMessage(adminId, text, { parse_mode: 'HTML' });
    } catch (error) {
      logger.warn(`notify admin ${adminId} failed`, error);
    }
  }
}

const manager = new SessionManager(notifyAdmins);

registerPanel(bot, manager);

bot.catch((err) => {
  logger.error(`update ${err.ctx.update.update_id}`, err.error);
});

async function main() {
  logger.info(`MC target ${MC_HOST}:${MC_PORT} (${MC_VERSION})`);
  logger.info(`Admins: ${ADMIN_IDS.join(', ') || 'none'}`);

  process.on('SIGINT', () => {
    manager.shutdownAll();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    manager.shutdownAll();
    process.exit(0);
  });

  await bot.start({
    onStart: (info) => logger.info(`TG bot @${info.username} started`),
  });
}

main().catch((error) => {
  logger.error('fatal', error);
  process.exit(1);
});
