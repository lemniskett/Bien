import { MessageReferenceType } from 'discord.js';
import { config, offsetLabel } from '../config.js';
import { logger } from '../logger.js';
import { readRoster } from '../roster.js';
import { chunk } from './reminderNotifier.js';
import { downloadImages } from './attachments.js';
import { parseOutbound } from './outboundAttachments.js';
import { touch, isActive, activeCount } from './activeSessions.js';

// Whole-word match for the bot's name, tolerating elongated spellings (bbbbien, biieeeenn, biennnnnn).
const NAME_TRIGGER = /\bb+i+e+n+\b/i;

// A quoted message is context, not the request — cap it so it can't eat the turn budget.
const MAX_QUOTE_CHARS = 600;

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

/** Strip the bot's own mention and flatten to single-line-ish text. */
function cleanContent(raw, botId) {
  return String(raw ?? '')
    .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/**
 * Resolve what a reply is pointing at, cheapest source first.
 *
 * discord.js puts the payload's `referenced_message` straight into the channel cache, so the
 * common case costs zero API calls. Returns null for non-replies, or `{ unreadable: true }`
 * when a reference exists but the message is gone — the model needs to be told that rather
 * than left to invent a referent.
 */
async function resolveReplyTarget(message, botId) {
  const ref = message.reference;
  if (!ref?.messageId) return null; // not a reply — the overwhelmingly common path

  const forwarded = ref.type === MessageReferenceType.Forward;
  let target = forwarded ? message.messageSnapshots?.first() : null;
  target ??= message.channel?.messages?.cache?.get(ref.messageId);
  if (!target) {
    try {
      target = await message.fetchReference();
    } catch (err) {
      logger.warn(`[reply] could not read quoted message ${ref.messageId}: ${err.message}`);
      return { unreadable: true };
    }
  }
  if (!target) return { unreadable: true };

  const isSelf = target.author?.id === botId;
  const name = target.member?.displayName || target.author?.username || 'someone';
  let text = cleanContent(target.content, botId);
  if (text.length > MAX_QUOTE_CHARS) text = `${text.slice(0, MAX_QUOTE_CHARS)}…`;

  return {
    author: isSelf ? 'bien (you)' : name,
    forwarded,
    text,
    images: await downloadImages(target),
  };
}

/** Render the [replying_to] block, or '' when the message isn't a reply. */
function replyBlock(replyTo) {
  if (!replyTo) return '';
  if (replyTo.unreadable) {
    return '[replying_to]\n(the quoted message could not be read — ask what they mean)\n';
  }
  const lines = [
    '[replying_to]',
    `author: ${replyTo.author}${replyTo.forwarded ? '   (forwarded)' : ''}`,
    `text: ${replyTo.text || '(no text)'}`,
  ];
  if (replyTo.images.length) {
    lines.push(`images: ${replyTo.images.map((i) => i.rel).join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Build the context header + user message the AI receives.
 */
async function buildPrompt(message, cleanText, images, replyTo) {
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
    replyBlock(replyTo) +
    '[message]\n' +
    (cleanText || (replyTo ? '(no text — see the quoted message)' : '(no text — see the attached image)'));
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
      // `repliedUser` comes from the payload's referenced_message, so it's set whether or not
      // the reply actually pings — a reply to Bien reaches him with notifications off.
      const repliedToBot = message.mentions?.repliedUser?.id === client.user.id;
      const triggered = mentioned || named || repliedToBot;
      // In servers: respond if tagged/named OR replying to one of Bien's own messages OR the
      // user has an active session. Replying to *someone else* still needs a tag or his name,
      // so he doesn't interject in every conversation. (DMs always proceed, as before.)
      if (inGuild && !triggered && !isActive(channelId, userId, now)) return;

      const cleanText = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
      const images = await downloadImages(message);
      const replyTo = await resolveReplyTarget(message, client.user.id);
      // Nothing to act on — unless they quoted something, which is itself the request.
      if (!cleanText && images.length === 0 && !replyTo) return;

      touch(channelId, userId, config.sessionTtlMs, now); // start/extend this user's session
      const useReply = activeCount(channelId, now) >= 2; // quote only when 2+ users are active

      if (message.channel.sendTyping) message.channel.sendTyping().catch(() => {});

      const prompt = await buildPrompt(message, cleanText, images, replyTo);
      const env = {
        BIEN_USER_ID: message.author.id,
        BIEN_CHANNEL_ID: message.channelId,
        BIEN_GUILD_ID: message.guildId ?? '',
      };

      const reply = await runner.run({ prompt, channelId: message.channelId, env });
      const { text, files } = await parseOutbound(reply);

      // Text chunks, unless the reply was *only* attachment tokens (then chunk() would
      // emit the '(no reply)' placeholder — suppress it so we send a files-only message).
      let chunks = chunk(text);
      if (files.length && chunks.length === 1 && chunks[0] === '(no reply)') chunks = [];

      if (chunks.length === 0 && files.length) {
        // Files-only reply: no content, just the attachments.
        if (useReply) {
          await message.reply({ files, allowedMentions: { repliedUser: true } });
        } else {
          await message.channel.send({ files, allowedMentions: { parse: [] } });
        }
      } else {
        for (let i = 0; i < chunks.length; i++) {
          const first = i === 0;
          const opts = { content: chunks[i] };
          if (first && files.length) opts.files = files; // attach to the first message only
          if (first && useReply) {
            await message.reply({ ...opts, allowedMentions: { repliedUser: true } });
          } else {
            await message.channel.send({ ...opts, allowedMentions: { parse: [] } });
          }
        }
      }
    } catch (err) {
      logger.error(`[message] handler error: ${err.stack || err.message}`);
      try {
        await message.reply({ content: '…something broke, nya. try again, nya.', allowedMentions: { parse: [] } });
      } catch {
        /* ignore */
      }
    }
  };
}

export default { createMessageHandler };
