import { Events } from 'discord.js';
import { config, loadBotConfig, offsetLabel } from './config.js';
import { logger } from './logger.js';
import { runStartupTasks } from './startup.js';
import { createClient } from './discord/client.js';
import { createMessageHandler } from './discord/messageHandler.js';
import { handleAckInteraction } from './discord/reminderNotifier.js';
import { refreshRoster, attachRosterEvents } from './discord/roster.js';
import { createRunner } from './ai/index.js';
import { createScheduler } from './scheduler.js';

async function main() {
  const bot = loadBotConfig();
  await runStartupTasks();

  logger.info(
    `[bien] starting — cli=${bot.aiCli} model=${bot.aiModel} tz=${offsetLabel(config.timezoneOffsetMinutes)}`,
  );

  const client = createClient();
  const runner = createRunner(bot);
  const scheduler = createScheduler({ client, runner });
  const onMessage = createMessageHandler({ client, runner });

  client.once(Events.ClientReady, async (c) => {
    logger.info(`[bien] logged in as ${c.user.tag}`);
    await refreshRoster(client).catch((e) => logger.warn(`[roster] initial sync failed: ${e.message}`));
    attachRosterEvents(client);
    scheduler.start();
  });

  client.on(Events.MessageCreate, onMessage);
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handleAckInteraction(interaction);
    } catch (err) {
      logger.error(`[interaction] ${err.stack || err.message}`);
    }
  });

  const shutdown = () => {
    logger.info('[bien] shutting down');
    scheduler.stop();
    client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await client.login(bot.discordToken);
}

main().catch((err) => {
  logger.error(err.stack || err.message);
  process.exit(1);
});
