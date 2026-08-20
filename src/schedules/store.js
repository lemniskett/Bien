import path from 'node:path';
import { config } from '../config.js';
import { listJson, writeJsonAtomic, readJson, newId } from '../lib/atomicJson.js';
import { validateCron, nextFireUtc } from './cron.js';

export const ACTION_TYPES = ['ai', 'message'];
export const SCHEDULE_STATUSES = ['active', 'paused', 'cancelled'];

const fileFor = (id) => path.join(config.schedulesDir, `${id}.json`);

function assertTitle(title) {
  if (!title || !String(title).trim()) throw new Error('schedule --title is required');
  return String(title).trim();
}

function assertCron(cron) {
  const v = validateCron(cron);
  if (!v.ok) throw new Error(`invalid --cron "${cron}": ${v.error}`);
  return cron;
}

function assertActionType(actionType) {
  if (!ACTION_TYPES.includes(actionType)) {
    throw new Error(`--action-type must be one of ${ACTION_TYPES.join('|')}`);
  }
  return actionType;
}

function assertAction(action) {
  if (!action || !String(action).trim()) throw new Error('schedule --action is required');
  return String(action).trim();
}

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
  const cleanTitle = assertTitle(title);
  assertCron(cron);
  assertActionType(actionType);
  const cleanAction = assertAction(action);
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
    title: cleanTitle,
    cron,
    cron_source: cronSource ? String(cronSource) : null,
    action_type: actionType,
    action: cleanAction,
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

/**
 * Validated in-place edit. Only the fields present in `patch` change. A new `cron`
 * re-derives `next_fire_at` in the configured offset (same call `createSchedule` uses);
 * otherwise the existing fire time is left alone. Status is never touched — a paused
 * schedule stays paused.
 *
 * @param {string} id
 * @param {{ title?: string, cron?: string, cronSource?: string, actionType?: string,
 *           action?: string, targets?: string[] }} patch
 */
export async function editSchedule(id, { title, cron, cronSource, actionType, action, targets } = {}) {
  const current = await getSchedule(id);
  if (!current) throw new Error(`no schedule with id ${id}`);
  if (current.status === 'cancelled') {
    throw new Error(`schedule ${id} is cancelled — add a new one instead`);
  }

  const next = { ...current };
  if (title !== undefined) next.title = assertTitle(title);
  if (actionType !== undefined) next.action_type = assertActionType(actionType);
  if (action !== undefined) next.action = assertAction(action);
  if (cronSource !== undefined) next.cron_source = String(cronSource);
  if (targets !== undefined && targets.length) next.targets = targets;
  if (cron !== undefined) {
    next.cron = assertCron(cron);
    next.next_fire_at = nextFireUtc(next.cron, { after: new Date() }).toISOString();
  }

  return saveSchedule(next);
}

export { fileFor as scheduleFile };
