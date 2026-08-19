import { config } from './config.js';
import { readJson, writeJsonAtomic } from './lib/atomicJson.js';

const EMPTY = { members: [], aliases: {} };

export async function readRoster() {
  try {
    const data = await readJson(config.rosterFile);
    return { members: data.members ?? [], aliases: data.aliases ?? {} };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...EMPTY };
    throw err;
  }
}

export async function writeRoster(roster) {
  await writeJsonAtomic(config.rosterFile, {
    members: roster.members ?? [],
    aliases: roster.aliases ?? {},
  });
}

/** Replace the member list (called by the bot on startup / member events), keep aliases. */
export async function syncMembers(members) {
  const roster = await readRoster();
  roster.members = members;
  await writeRoster(roster);
  return roster;
}

function candidateNames(m) {
  return [m.displayName, m.globalName, m.username].filter(Boolean).map((s) => s.toLowerCase());
}

/**
 * Resolve one raw target (keyword or member name) to a canonical token.
 * Returns { token } or { error, candidates? }.
 */
export function resolveOne(raw, { selfId, roster }) {
  const s = String(raw).trim();
  const lower = s.toLowerCase();
  if (lower === 'self' || lower === 'me') {
    if (!selfId) return { error: 'cannot target self: no requester id available' };
    return { token: `user:${selfId}` };
  }
  if (lower === 'everyone' || lower === '@everyone') return { token: 'everyone' };
  if (lower === 'here' || lower === '@here') return { token: 'here' };

  // taught alias wins
  if (roster.aliases && roster.aliases[lower]) return { token: roster.aliases[lower] };

  const matches = (roster.members ?? []).filter((m) => candidateNames(m).includes(lower));
  const uniqueIds = [...new Set(matches.map((m) => m.id))];
  if (uniqueIds.length === 1) return { token: `user:${uniqueIds[0]}` };
  if (uniqueIds.length === 0) return { error: `unknown member "${s}"` };
  return {
    error: `"${s}" is ambiguous`,
    candidates: matches.map((m) => m.displayName || m.globalName || m.username),
  };
}

/**
 * Resolve a list of raw targets. Returns { tokens, errors }.
 * Deduplicates tokens preserving order.
 */
export function resolveTargets(rawList, { selfId, roster }) {
  const tokens = [];
  const errors = [];
  for (const raw of rawList) {
    const r = resolveOne(raw, { selfId, roster });
    if (r.error) {
      errors.push(r.candidates ? `${r.error} — candidates: ${r.candidates.join(', ')}` : r.error);
    } else if (!tokens.includes(r.token)) {
      tokens.push(r.token);
    }
  }
  return { tokens, errors };
}

/** Teach an alias: `bien roster alias "mom" <existing target>`. */
export async function addAlias(name, rawTarget, { selfId } = {}) {
  const roster = await readRoster();
  const r = resolveOne(rawTarget, { selfId, roster });
  if (r.error) throw new Error(r.error);
  roster.aliases = roster.aliases ?? {};
  roster.aliases[String(name).trim().toLowerCase()] = r.token;
  await writeRoster(roster);
  return { alias: String(name).trim().toLowerCase(), token: r.token };
}

export default { readRoster, writeRoster, syncMembers, resolveOne, resolveTargets, addAlias };
