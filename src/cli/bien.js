#!/usr/bin/env node
import { config, offsetLabel } from '../config.js';
import {
  createReminder,
  listReminders,
  getReminder,
  updateReminder,
  editReminder,
} from '../reminders/store.js';
import {
  createSchedule,
  listSchedules,
  getSchedule,
  updateSchedule,
  editSchedule,
} from '../schedules/store.js';
import { nextFireUtc } from '../schedules/cron.js';
import { readRoster, resolveTargets, addAlias } from '../roster.js';

// ---------- tiny arg parser ----------
// Collects positionals into `_` and flags into arrays (so repeated flags like --target work).
function parseArgs(argv) {
  const _ = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        (flags[key] ??= []).push(true); // boolean flag
      } else {
        (flags[key] ??= []).push(next);
        i++;
      }
    } else {
      _.push(a);
    }
  }
  return {
    _,
    first: (k, d) => (flags[k]?.[0] !== undefined ? flags[k][0] : d),
    all: (k) => flags[k] ?? [],
    has: (k) => k in flags,
  };
}

function die(msg) {
  console.error(`bien: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(msg);
  process.exit(0);
}

function ids(args) {
  return {
    createdBy: args.first('user', process.env.BIEN_USER_ID),
    channelId: args.first('channel', process.env.BIEN_CHANNEL_ID),
    guildId: args.first('guild', process.env.BIEN_GUILD_ID),
  };
}

/**
 * Read a flag that must carry a value. `parseArgs` records a valueless `--foo` as boolean
 * `true`; on an update that would silently overwrite a real field with garbage, so reject it.
 * Returns undefined when the flag is absent.
 */
function strFlag(args, name) {
  if (!args.has(name)) return undefined;
  const v = args.first(name);
  if (v === true) die(`--${name} needs a value`);
  return v;
}

function fmtLocal(iso) {
  if (!iso) return '(none)';
  const d = new Date(iso);
  const shifted = new Date(d.getTime() + config.timezoneOffsetMinutes * 60_000);
  const local = shifted.toISOString().replace('T', ' ').slice(0, 16);
  return `${local} ${offsetLabel(config.timezoneOffsetMinutes)}`;
}

function describeTargets(tokens) {
  return (tokens ?? [])
    .map((t) => (t === 'everyone' ? '@everyone' : t === 'here' ? '@here' : t.replace('user:', '@')))
    .join(', ');
}

async function resolveOrDie(args, selfId) {
  const raw = args.all('target').filter((t) => t !== true);
  if (raw.length === 0) return undefined; // store defaults to self
  const roster = await readRoster();
  const { tokens, errors } = resolveTargets(raw, { selfId, roster });
  if (errors.length) die(`could not resolve targets:\n  - ${errors.join('\n  - ')}`);
  return tokens;
}

// ---------- commands ----------
async function cmdReminder(args) {
  const sub = args._[1];
  if (sub === 'add') {
    const { createdBy, channelId, guildId } = ids(args);
    const targets = await resolveOrDie(args, createdBy);
    const rec = await createReminder({
      text: args.first('text'),
      dueAt: args.first('due'),
      recurrence: args.first('recurrence', 'none'),
      targets,
      createdBy,
      channelId,
      guildId,
    }).catch((e) => die(e.message));
    ok(
      `✓ reminder ${rec.id} set for ${fmtLocal(rec.due_at)} → ${describeTargets(rec.targets)}` +
        (rec.recurrence !== 'none' ? ` (repeats ${rec.recurrence})` : ''),
    );
  }
  if (sub === 'cancel') {
    const id = args._[2];
    if (!id) die('usage: bien reminder cancel <id>');
    const rec = await getReminder(id);
    if (!rec) die(`no reminder with id ${id}`);
    await updateReminder(id, { status: 'cancelled' });
    ok(`✓ reminder ${id} cancelled`);
  }
  if (sub === 'update') {
    const id = args._[2];
    if (!id) {
      die('usage: bien reminder update <id> [--text <str>] [--due <UTC ISO>] [--recurrence <r>] [--target <t>...]');
    }
    const { createdBy } = ids(args);
    const patch = {};
    const text = strFlag(args, 'text');
    if (text !== undefined) patch.text = text;
    const due = strFlag(args, 'due');
    if (due !== undefined) patch.dueAt = due;
    const recurrence = strFlag(args, 'recurrence');
    if (recurrence !== undefined) patch.recurrence = recurrence;
    if (args.has('target')) {
      const targets = await resolveOrDie(args, createdBy);
      if (!targets || !targets.length) die('--target needs a value');
      patch.targets = targets;
    }
    if (Object.keys(patch).length === 0) {
      die('nothing to update — pass at least one of --text/--due/--recurrence/--target');
    }
    const rec = await editReminder(id, patch).catch((e) => die(e.message));
    ok(
      `✓ reminder ${rec.id} updated: "${rec.text}" due ${fmtLocal(rec.due_at)} → ${describeTargets(rec.targets)}` +
        (rec.recurrence !== 'none' ? ` (repeats ${rec.recurrence})` : ''),
    );
  }
  die('usage: bien reminder <add|update|cancel> ...');
}

async function cmdSchedule(args) {
  const sub = args._[1];
  if (sub === 'add') {
    const { createdBy, channelId, guildId } = ids(args);
    const targets = await resolveOrDie(args, createdBy);
    const rec = await createSchedule({
      title: args.first('title'),
      cron: args.first('cron'),
      cronSource: args.first('cron-source'),
      actionType: args.first('action-type'),
      action: args.first('action'),
      targets,
      createdBy,
      channelId,
      guildId,
    }).catch((e) => die(e.message));
    ok(
      `✓ schedule ${rec.id} "${rec.title}" (${rec.cron}) next fires ${fmtLocal(rec.next_fire_at)} → ${describeTargets(rec.targets)}`,
    );
  }
  if (sub === 'pause' || sub === 'cancel') {
    const id = args._[2];
    if (!id) die(`usage: bien schedule ${sub} <id>`);
    const rec = await getSchedule(id);
    if (!rec) die(`no schedule with id ${id}`);
    await updateSchedule(id, { status: sub === 'pause' ? 'paused' : 'cancelled' });
    ok(`✓ schedule ${id} ${sub === 'pause' ? 'paused' : 'cancelled'}`);
  }
  if (sub === 'update') {
    const id = args._[2];
    if (!id) {
      die('usage: bien schedule update <id> [--title <str>] [--cron <expr>] [--action-type <ai|message>] [--action <str>] [--cron-source <str>] [--target <t>...]');
    }
    const { createdBy } = ids(args);
    const patch = {};
    const title = strFlag(args, 'title');
    if (title !== undefined) patch.title = title;
    const cron = strFlag(args, 'cron');
    if (cron !== undefined) patch.cron = cron;
    const cronSource = strFlag(args, 'cron-source');
    if (cronSource !== undefined) patch.cronSource = cronSource;
    const actionType = strFlag(args, 'action-type');
    if (actionType !== undefined) patch.actionType = actionType;
    const action = strFlag(args, 'action');
    if (action !== undefined) patch.action = action;
    if (args.has('target')) {
      const targets = await resolveOrDie(args, createdBy);
      if (!targets || !targets.length) die('--target needs a value');
      patch.targets = targets;
    }
    if (Object.keys(patch).length === 0) {
      die('nothing to update — pass at least one of --title/--cron/--action-type/--action/--cron-source/--target');
    }
    const rec = await editSchedule(id, patch).catch((e) => die(e.message));
    ok(
      `✓ schedule ${rec.id} updated: "${rec.title}" (${rec.cron}) next fires ${fmtLocal(rec.next_fire_at)} → ${describeTargets(rec.targets)}` +
        (rec.status !== 'active' ? ` [still ${rec.status}]` : ''),
    );
  }
  die('usage: bien schedule <add|update|pause|cancel> ...');
}

async function cmdList(args) {
  const which = args._[1];
  const lines = [];
  if (!which || which === 'reminders') {
    const rs = (await listReminders()).filter((r) => !['cancelled', 'acknowledged'].includes(r.status));
    lines.push('REMINDERS (active):');
    if (rs.length === 0) lines.push('  (none)');
    for (const r of rs) {
      lines.push(
        `  ${r.id}  "${r.text}"  ${r.status}  next=${fmtLocal(r.next_fire_at)}  → ${describeTargets(r.targets)}`,
      );
    }
  }
  if (!which || which === 'schedules') {
    const ss = (await listSchedules()).filter((s) => s.status !== 'cancelled');
    lines.push('SCHEDULES:');
    if (ss.length === 0) lines.push('  (none)');
    for (const s of ss) {
      lines.push(
        `  ${s.id}  "${s.title}"  ${s.cron}  ${s.status}  next=${fmtLocal(s.next_fire_at)}  [${s.action_type}]  → ${describeTargets(s.targets)}`,
      );
    }
  }
  ok(lines.join('\n'));
}

async function cmdRoster(args) {
  const sub = args._[1] ?? 'list';
  if (sub === 'list') {
    const roster = await readRoster();
    const lines = ['MEMBERS:'];
    for (const m of roster.members) {
      lines.push(`  ${m.id}  ${m.displayName || m.globalName || m.username}  (@${m.username})`);
    }
    if (roster.members.length === 0) lines.push('  (roster empty — is the bot running?)');
    const aliasKeys = Object.keys(roster.aliases ?? {});
    if (aliasKeys.length) {
      lines.push('ALIASES:');
      for (const k of aliasKeys) lines.push(`  ${k} → ${describeTargets([roster.aliases[k]])}`);
    }
    ok(lines.join('\n'));
  }
  if (sub === 'alias') {
    const name = args._[2];
    const target = args._[3];
    if (!name || !target) die('usage: bien roster alias <name> <member-name|everyone|here>');
    const res = await addAlias(name, target, { selfId: process.env.BIEN_USER_ID }).catch((e) =>
      die(e.message),
    );
    ok(`✓ alias "${res.alias}" → ${describeTargets([res.token])}`);
  }
  die('usage: bien roster <list|alias> ...');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  switch (cmd) {
    case 'reminder':
      return cmdReminder(args);
    case 'schedule':
      return cmdSchedule(args);
    case 'list':
      return cmdList(args);
    case 'roster':
      return cmdRoster(args);
    default:
      die(
        'usage: bien <reminder|schedule|list|roster> ...\n' +
          '  reminder add --text <str> --due <UTC ISO> [--recurrence none|daily|weekly] [--target <t>...]\n' +
          '  reminder update <id> [--text <str>] [--due <UTC ISO>] [--recurrence <r>] [--target <t>...]\n' +
          '  reminder cancel <id>\n' +
          '  schedule add --title <str> --cron <expr> --action-type <ai|message> --action <str> [--target <t>...]\n' +
          '  schedule update <id> [--title <str>] [--cron <expr>] [--action-type <t>] [--action <str>] [--target <t>...]\n' +
          '  schedule pause|cancel <id>\n' +
          '  list [reminders|schedules]\n' +
          '  roster [list] | roster alias <name> <target>',
      );
  }
}

main().catch((e) => die(e.stack || e.message));
