import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { logger } from '../logger.js';
import { buildMentions } from './mentions.js';
import { getReminder, updateReminder } from '../reminders/store.js';

const ACK_PREFIX = 'ack:';

async function fetchChannel(client, channelId) {
  const cached = client.channels.cache.get(channelId);
  if (cached) return cached;
  return client.channels.fetch(channelId).catch(() => null);
}

/** Split long text into <=2000 char chunks on line boundaries where possible. */
export function chunk(text, max = 2000) {
  const out = [];
  let rest = String(text ?? '').trim();
  if (!rest) return ['(no reply)'];
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

/** Post a plain message to a channel with resolved target mentions (used by schedules). */
export async function sendToChannel(client, channelId, tokens, body) {
  const channel = await fetchChannel(client, channelId);
  if (!channel) {
    logger.warn(`[notify] channel ${channelId} not found`);
    return null;
  }
  const { content, allowedMentions } = buildMentions(tokens);
  const full = content ? `${content} ${body}` : body;
  const chunks = chunk(full);
  let last = null;
  for (let i = 0; i < chunks.length; i++) {
    last = await channel.send({
      content: chunks[i],
      allowedMentions: i === 0 ? allowedMentions : { parse: [] },
    });
  }
  return last;
}

/** Fire a reminder ping with an Acknowledge button. */
export async function sendReminderPing(client, reminder, { pingNum, nagMax }) {
  const channel = await fetchChannel(client, reminder.channel_id);
  if (!channel) {
    logger.warn(`[notify] reminder ${reminder.id}: channel ${reminder.channel_id} not found`);
    return null;
  }
  const { content, allowedMentions } = buildMentions(reminder.targets);
  const body = `⏰ Reminder: ${reminder.text}  _(ping ${pingNum}/${nagMax})_`;
  const button = new ButtonBuilder()
    .setCustomId(`${ACK_PREFIX}${reminder.id}`)
    .setLabel('Acknowledge')
    .setEmoji('✅')
    .setStyle(ButtonStyle.Success);
  const row = new ActionRowBuilder().addComponents(button);
  return channel.send({
    content: content ? `${content} ${body}` : body,
    allowedMentions,
    components: [row],
  });
}

/** Handle the Acknowledge button. Returns true if it was an ack interaction. */
export async function handleAckInteraction(interaction) {
  if (!interaction.isButton?.() || !interaction.customId.startsWith(ACK_PREFIX)) return false;
  const id = interaction.customId.slice(ACK_PREFIX.length);
  const reminder = await getReminder(id);
  if (!reminder) {
    await interaction.reply({ content: 'That reminder is already gone, nya.', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (reminder.status !== 'nagging' && reminder.status !== 'scheduled') {
    await interaction.reply({ content: 'Already handled.', flags: MessageFlags.Ephemeral });
    return true;
  }
  await updateReminder(id, { status: 'acknowledged' });
  const who = interaction.user ? `<@${interaction.user.id}>` : 'someone';
  await interaction.update({
    content: `✅ Acknowledged by ${who}: ${reminder.text}`,
    components: [],
    allowedMentions: { parse: [] },
  });
  logger.info(`[notify] reminder ${id} acknowledged`);
  return true;
}

export default { sendToChannel, sendReminderPing, handleAckInteraction, chunk };
