import path from 'node:path';
import { config } from '../config.js';
import { listJson, writeJsonAtomic, readJson, newId } from '../lib/atomicJson.js';
import { validateCron, nextFireUtc } from './cron.js';

export const ACTION_TYPES = ['ai', 'message'];
export const SCHEDULE_STATUSES = ['active', 'paused', 'cancelled'];

const fileFor = (id) => path.join(config.schedulesDir, `${id}.json`);

/**
 * Build + persist a new schedule. `cron` is a 5-field expression; the first `next_fire_at`
 * is computed in the configured timezone offset. `targets` defaults to the creator.
 */
export async function createSchedule({
  title,
  cron,
  cronSource,
  actionType,
  action,
  targets,
  createdBy,
  channelId,
  guildId,
}) {
  if (!title || !String(title).trim()) throw new Error('schedule --title is required');
  const v = validateCron(cron);
  if (!v.ok) throw new Error(`invalid --cron "${cron}": ${v.error}`);
  if (!ACTION_TYPES.includes(actionType)) {
    throw new Error(`--action-type must be one of ${ACTION_TYPES.join('|')}`);
  }
  if (!action || !String(action).trim()) throw new Error('schedule --action is required');
  if (!createdBy) throw new Error('no user id available (set BIEN_USER_ID or pass --user)');
  if (!channelId) throw new Error('no channel id available (set BIEN_CHANNEL_ID or pass --channel)');

  const resolvedTargets = targets && targets.length ? targets : [`user:${createdBy}`];
  const next = nextFireUtc(cron, { after: new Date() });
  const record = {
    id: newId(),
    created_at: new Date().toISOString(),
    created_by: String(createdBy),
    channel_id: String(channelId),
    guild_id: guildId ? String(guildId) : null,
    targets: resolvedTargets,
    title: String(title).trim(),
    cron,
    cron_source: cronSource ? String(cronSource) : null,
    action_type: actionType,
    action: String(action).trim(),
    status: 'active',
    last_fired_at: null,
    next_fire_at: next.toISOString(),
  };
  await writeJsonAtomic(fileFor(record.id), record);
  return record;
}

export async function listSchedules() {
  const rows = await listJson(config.schedulesDir);
  return rows.map((r) => r.data);
}

export async function getSchedule(id) {
  try {
    return await readJson(fileFor(id));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveSchedule(record) {
  await writeJsonAtomic(fileFor(record.id), record);
  return record;
}

export async function updateSchedule(id, patch) {
  const current = await getSchedule(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  await saveSchedule(next);
  return next;
}

export { fileFor as scheduleFile };
