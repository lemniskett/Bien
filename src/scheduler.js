import { config } from './config.js';
import { logger } from './logger.js';
import {
  listReminders,
  saveReminder,
  createReminder,
  pruneStaleReminders,
} from './reminders/store.js';
import { listSchedules, saveSchedule } from './schedules/store.js';
import { nextFireUtc } from './schedules/cron.js';
import { sendReminderPing, sendToChannel } from './discord/reminderNotifier.js';

function nextRecurrenceISO(dueISO, recurrence) {
  const stepMs = recurrence === 'daily' ? 86_400_000 : recurrence === 'weekly' ? 7 * 86_400_000 : 0;
  if (!stepMs) return null;
  let next = new Date(dueISO).getTime() + stepMs;
  const now = Date.now();
  while (next <= now) next += stepMs;
  return new Date(next).toISOString();
}

export function createScheduler({ client, runner }) {
  let timer = null;
  let running = false;

  async function tickReminders(now) {
    const reminders = await listReminders();
    for (const r of reminders) {
      try {
        if (r.status === 'scheduled' && new Date(r.due_at).getTime() <= now) {
          await sendReminderPing(client, r, { pingNum: 1, nagMax: config.nagMax });
          await saveReminder({
            ...r,
            status: 'nagging',
            fired_count: 1,
            last_fired_at: new Date(now).toISOString(),
            next_fire_at: new Date(now + config.nagIntervalMs).toISOString(),
          });
        } else if (r.status === 'nagging' && new Date(r.next_fire_at).getTime() <= now) {
          if (r.fired_count >= config.nagMax) {
            await saveReminder({ ...r, status: 'exhausted' });
          } else {
            const pingNum = r.fired_count + 1;
            await sendReminderPing(client, r, { pingNum, nagMax: config.nagMax });
            await saveReminder({
              ...r,
              fired_count: pingNum,
              last_fired_at: new Date(now).toISOString(),
              next_fire_at: new Date(now + config.nagIntervalMs).toISOString(),
            });
          }
        } else if (
          (r.status === 'acknowledged' || r.status === 'exhausted') &&
          r.recurrence &&
          r.recurrence !== 'none' &&
          !r.rolled
        ) {
          // Roll a recurring reminder forward exactly once.
          const nextDue = nextRecurrenceISO(r.due_at, r.recurrence);
          if (nextDue) {
            await createReminder({
              text: r.text,
              dueAt: nextDue,
              recurrence: r.recurrence,
              targets: r.targets,
              createdBy: r.created_by,
              channelId: r.channel_id,
              guildId: r.guild_id,
            });
          }
          await saveReminder({ ...r, rolled: true });
        }
      } catch (err) {
        logger.error(`[scheduler] reminder ${r.id} failed: ${err.stack || err.message}`);
      }
    }
  }

  async function tickSchedules(now) {
    const schedules = await listSchedules();
    for (const s of schedules) {
      try {
        if (s.status !== 'active') continue;
        let nextAt = s.next_fire_at ? new Date(s.next_fire_at).getTime() : null;
        if (!nextAt) {
          nextAt = nextFireUtc(s.cron, { after: new Date(now) }).getTime();
          await saveSchedule({ ...s, next_fire_at: new Date(nextAt).toISOString() });
          continue;
        }
        if (nextAt > now) continue;

        // Fire (catch-up: fires once even if several ticks were missed).
        if (s.action_type === 'message') {
          await sendToChannel(client, s.channel_id, s.targets, `🔔 ${s.action}`);
        } else {
          const env = {
            BIEN_USER_ID: s.created_by,
            BIEN_CHANNEL_ID: s.channel_id,
            BIEN_GUILD_ID: s.guild_id ?? '',
          };
          const prompt =
            `[scheduled task "${s.title}" fired — respond as Bien, in character]\n${s.action}`;
          const reply = await runner.run({ prompt, channelId: s.channel_id, env });
          await sendToChannel(client, s.channel_id, s.targets, reply);
        }

        const next = nextFireUtc(s.cron, { after: new Date(now) });
        await saveSchedule({
          ...s,
          last_fired_at: new Date(now).toISOString(),
          next_fire_at: next.toISOString(),
        });
      } catch (err) {
        logger.error(`[scheduler] schedule ${s.id} failed: ${err.stack || err.message}`);
      }
    }
  }

  async function tick() {
    if (running) return; // never overlap ticks
    running = true;
    const now = Date.now();
    try {
      await tickReminders(now);
      await tickSchedules(now);
      await pruneStaleReminders(now).catch((err) =>
        logger.warn(`[scheduler] prune failed: ${err.message}`),
      );
    } catch (err) {
      logger.error(`[scheduler] tick error: ${err.stack || err.message}`);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      logger.info(`[scheduler] polling every ${config.pollIntervalMs}ms`);
      tick(); // run once immediately
      timer = setInterval(tick, config.pollIntervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick, // exposed for tests/manual triggering
  };
}

export default { createScheduler };
