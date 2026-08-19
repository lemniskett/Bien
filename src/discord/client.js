import { Client, GatewayIntentBits, Partials } from 'discord.js';

export function createClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // privileged
      GatewayIntentBits.GuildMembers, // privileged (roster for name->id targeting)
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel], // needed to receive DMs
  });
}

export default { createClient };
