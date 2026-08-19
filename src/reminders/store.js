import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { listJson, writeJsonAtomic, readJson, newId } from '../lib/atomicJson.js';

export const RECURRENCES = ['none', 'daily', 'weekly'];

/** Terminal reminders older than this are pruned so records don't accumulate forever. */
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TERMINAL_STATUSES = ['cancelled', 'acknowledged', 'exhausted'];
export const REMINDER_STATUSES = [
  'scheduled',
  'nagging',
  'acknowledged',
  'exhausted',
  'cancelled',
];

const fileFor = (id) => path.join(config.remindersDir, `${id}.json`);

/**
 * Build + persist a new reminder. `dueAt` must be an ISO string (UTC). `targets` is an
 * array of resolved tokens (everyone | here | user:<id>); defaults to the creator.
 */
export async function createReminder({
  text,
  dueAt,
  recurrence = 'none',
  targets,
  createdBy,
  channelId,
  guildId,
}) {
  if (!text || !String(text).trim()) throw new Error('reminder text is required');
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) throw new Error(`--due is not a valid date: ${dueAt}`);
  if (!RECURRENCES.includes(recurrence)) {
    throw new Error(`recurrence must be one of ${RECURRENCES.join('|')}`);
  }
  if (!createdBy) throw new Error('no user id available (set BIEN_USER_ID or pass --user)');
  if (!channelId) throw new Error('no channel id available (set BIEN_CHANNEL_ID or pass --channel)');

  const resolvedTargets = targets && targets.length ? targets : [`user:${createdBy}`];
  const iso = due.toISOString();
  const record = {
    id: newId(),
    created_at: new Date().toISOString(),
    created_by: String(createdBy),
    channel_id: String(channelId),
    guild_id: guildId ? String(guildId) : null,
    targets: resolvedTargets,
    text: String(text).trim(),
    due_at: iso,
    recurrence,
    status: 'scheduled',
    fired_count: 0,
    last_fired_at: null,
    next_fire_at: iso,
  };
  await writeJsonAtomic(fileFor(record.id), record);
  return record;
}

export async function listReminders() {
  const rows = await listJson(config.remindersDir);
  return rows.map((r) => r.data);
}

export async function getReminder(id) {
  try {
    return await readJson(fileFor(id));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Overwrite a reminder record (atomic). Used by the scheduler to advance state. */
export async function saveReminder(record) {
  await writeJsonAtomic(fileFor(record.id), record);
  return record;
}

/** Convenience: patch fields on an existing reminder. */
export async function updateReminder(id, patch) {
  const current = await getReminder(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  await saveReminder(next);
  return next;
}

/** Delete a reminder record file. Best-effort — a missing file is fine. */
export async function deleteReminder(id) {
  await fs.unlink(fileFor(id)).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

/**
 * Best-effort sweep: delete terminal-state reminders (cancelled/acknowledged/exhausted)
 * whose last activity is older than STALE_AFTER_MS. Active (scheduled/nagging) reminders
 * are never touched, regardless of age.
 */
export async function pruneStaleReminders(now = Date.now()) {
  const reminders = await listReminders();
  let pruned = 0;
  for (const r of reminders) {
    if (!TERMINAL_STATUSES.includes(r.status)) continue;
    const lastActivity = new Date(r.last_fired_at || r.created_at).getTime();
    if (!Number.isFinite(lastActivity) || now - lastActivity <= STALE_AFTER_MS) continue;
    try {
      await deleteReminder(r.id);
      pruned++;
    } catch (err) {
      logger.warn(`[reminders] failed to prune ${r.id}: ${err.message}`);
    }
  }
  if (pruned) logger.info(`[reminders] pruned ${pruned} stale reminder(s)`);
  return pruned;
}

export { fileFor as reminderFile };
