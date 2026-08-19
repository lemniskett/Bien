/**
 * In-memory tracker of who is actively talking to the bot, per channel.
 *
 * A user "enters" a session when they trigger the bot; the session slides forward on every
 * message and expires `ttlMs` after their last one. State is ephemeral — losing it on
 * restart is fine — so it lives in a module-level Map with no persistence (same style as
 * the per-channel promise chains in ../ai/queue.js). Expired entries are pruned lazily
 * whenever a channel is read or touched.
 */

const channels = new Map(); // channelId -> Map<userId, expiresAtMs>

function pruneChannel(channelId, now) {
  const users = channels.get(channelId);
  if (!users) return null;
  for (const [uid, exp] of users) if (exp <= now) users.delete(uid);
  if (users.size === 0) {
    channels.delete(channelId);
    return null;
  }
  return users;
}

/** Start or extend a user's active session in a channel. */
export function touch(channelId, userId, ttlMs, now = Date.now()) {
  let users = channels.get(channelId);
  if (!users) {
    users = new Map();
    channels.set(channelId, users);
  }
  users.set(userId, now + ttlMs);
}

/** True if the user has an unexpired session in the channel. */
export function isActive(channelId, userId, now = Date.now()) {
  const users = pruneChannel(channelId, now);
  return Boolean(users && users.has(userId));
}

/** Number of users with an unexpired session in the channel. */
export function activeCount(channelId, now = Date.now()) {
  const users = pruneChannel(channelId, now);
  return users ? users.size : 0;
}

export default { touch, isActive, activeCount };
