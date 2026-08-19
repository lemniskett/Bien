import { config, offsetLabel } from '../config.js';
import { logger } from '../logger.js';
import { readRoster } from '../roster.js';
import { chunk } from './reminderNotifier.js';
import { downloadImages } from './attachments.js';
import { touch, isActive, activeCount } from './activeSessions.js';

// Whole-word match for the bot's name, tolerating elongated spellings (bbbbien, biieeeenn, biennnnnn).
const NAME_TRIGGER = /\bb+i+e+n+\b/i;

function localNow() {
  const now = new Date();
  const shifted = new Date(now.getTime() + config.timezoneOffsetMinutes * 60_000);
  return {
    utc: now.toISOString(),
    local: shifted.toISOString().replace('T', ' ').slice(0, 19),
  };
}

async function rosterLine() {
  try {
    const roster = await readRoster();
    const names = roster.members.map((m) => m.displayName || m.globalName || m.username);
    if (!names.length) return '';
    return `known_members: ${names.join(', ')}\n`;
  } catch {
    return '';
  }
}

/**
 * Build the context header + user message the AI receives.
 */
async function buildPrompt(message, cleanText, images) {
  const { utc, local } = localNow();
  const imageLine = images.length
    ? `attached_images: ${images.map((i) => i.rel).join(', ')}   (the user attached these — read them with your file tools / Read to see what's in them, then act on the request)\n`
    : '';
  const header =
    '[context]\n' +
    `now_utc: ${utc}   timezone_offset: ${config.timezoneOffsetRaw}   (local now: ${local} ${offsetLabel(config.timezoneOffsetMinutes)})\n` +
    `requester_discord_id: ${message.author.id}   requester_name: ${message.member?.displayName || message.author.username}\n` +
    `channel_id: ${message.channelId}   guild_id: ${message.guildId ?? 'null'}\n` +
    (await rosterLine()) +
    imageLine +
    '[message]\n' +
    (cleanText || '(no text — see the attached image)');
  return header;
}

export function createMessageHandler({ client, runner }) {
  return async function onMessage(message) {
    try {
      if (message.author.bot) return;
      const inGuild = Boolean(message.guildId);
      const now = Date.now();
      const channelId = message.channelId;
      const userId = message.author.id;
      const mentioned = message.mentions?.users?.has(client.user.id);
      const named = NAME_TRIGGER.test(message.content);
      const triggered = mentioned || named;
      // In servers: respond if tagged/replied/named OR the user has an active session.
      // (DMs always proceed, as before.)
      if (inGuild && !triggered && !isActive(channelId, userId, now)) return;

      const cleanText = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
      const images = await downloadImages(message);
      if (!cleanText && images.length === 0) return; // nothing to act on

      touch(channelId, userId, config.sessionTtlMs, now); // start/extend this user's session
      const useReply = activeCount(channelId, now) >= 2; // quote only when 2+ users are active

      if (message.channel.sendTyping) message.channel.sendTyping().catch(() => {});

      const prompt = await buildPrompt(message, cleanText, images);
      const env = {
        BIEN_USER_ID: message.author.id,
        BIEN_CHANNEL_ID: message.channelId,
        BIEN_GUILD_ID: message.guildId ?? '',
      };

      const reply = await runner.run({ prompt, channelId: message.channelId, env });
      const chunks = chunk(reply);
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0 && useReply) {
          await message.reply({ content: chunks[i], allowedMentions: { repliedUser: true } });
        } else {
          await message.channel.send({ content: chunks[i], allowedMentions: { parse: [] } });
        }
      }
    } catch (err) {
      logger.error(`[message] handler error: ${err.stack || err.message}`);
      try {
        await message.reply({ content: '…something broke. Try again, nya.', allowedMentions: { parse: [] } });
      } catch {
        /* ignore */
      }
    }
  };
}

export default { createMessageHandler };
