import { CronExpressionParser } from 'cron-parser';
import { config } from '../config.js';

/**
 * Validate a 5-field cron expression. Returns { ok:true } or { ok:false, error }.
 */
export function validateCron(expr) {
  try {
    CronExpressionParser.parse(expr, { currentDate: new Date(0), tz: 'UTC' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Next fire instant (UTC Date) strictly after `after`, for a cron interpreted in the
 * configured fixed offset.
 *
 * Trick: a fixed offset has no DST, so we evaluate the cron against a "shifted" clock
 * (real time + offset) in UTC, then shift the result back. This handles half-hour
 * offsets that Etc/GMT zones can't express.
 */
export function nextFireUtc(expr, { after = new Date(), offsetMinutes = config.timezoneOffsetMinutes } = {}) {
  const offsetMs = offsetMinutes * 60_000;
  const shiftedNow = new Date(after.getTime() + offsetMs);
  const it = CronExpressionParser.parse(expr, { currentDate: shiftedNow, tz: 'UTC' });
  const nextShifted = it.next().toDate();
  return new Date(nextShifted.getTime() - offsetMs);
}

export default { validateCron, nextFireUtc };
