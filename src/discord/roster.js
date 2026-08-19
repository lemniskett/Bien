import { logger } from '../logger.js';
import { syncMembers } from '../roster.js';

function memberToEntry(member) {
  const user = member.user;
  return {
    id: user.id,
    username: user.username,
    globalName: user.globalName ?? null,
    displayName: member.displayName ?? user.globalName ?? user.username,
  };
}

/** Fetch all members across all guilds and write them to data/roster.json. */
export async function refreshRoster(client) {
  const seen = new Map();
  for (const guild of client.guilds.cache.values()) {
    try {
      const members = await guild.members.fetch();
      for (const member of members.values()) {
        if (member.user.bot) continue;
        seen.set(member.user.id, memberToEntry(member));
      }
    } catch (err) {
      logger.warn(`[roster] could not fetch members for guild ${guild.id}: ${err.message}`);
    }
  }
  await syncMembers([...seen.values()]);
  logger.info(`[roster] synced ${seen.size} members`);
}

/** Attach live updates so the roster stays current without a full refetch. */
export function attachRosterEvents(client) {
  const single = async (member) => {
    if (member.partial) {
      try {
        member = await member.fetch();
      } catch {
        return;
      }
    }
    if (member.user?.bot) return;
    await refreshRoster(client).catch((e) => logger.warn(`[roster] refresh failed: ${e.message}`));
  };
  client.on('guildMemberAdd', single);
  client.on('guildMemberUpdate', (_old, m) => single(m));
  client.on('guildMemberRemove', single);
}

export default { refreshRoster, attachRosterEvents };
