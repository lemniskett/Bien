import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Always load .env from the project root, regardless of the process cwd
// (the `bien` CLI is spawned with cwd = workspace/, so a cwd-relative lookup would miss it).
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

function required(name) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return String(v).trim();
}

function optionalInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || String(v).trim() === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be an integer, got "${v}"`);
  return n;
}

/**
 * Parse a fixed UTC offset like "UTC+7", "UTC-5", "UTC+5:30", "+07:00" into signed minutes.
 * "UTC" alone => 0. Defaults to 0 when unset (the CLI can still run standalone).
 */
export function parseOffsetMinutes(raw) {
  const s = String(raw ?? '').trim();
  if (s === '' || /^UTC$/i.test(s)) return 0;
  const m = s.match(/^(?:UTC|GMT)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i);
  if (!m) {
    throw new Error(
      `TIMEZONE_OFFSET "${raw}" is not a valid fixed offset (examples: UTC+7, UTC-5, UTC+5:30)`,
    );
  }
  const sign = m[1] === '-' ? -1 : 1;
  const hours = Number.parseInt(m[2], 10);
  const mins = m[3] ? Number.parseInt(m[3], 10) : 0;
  if (hours > 14 || mins > 59) throw new Error(`TIMEZONE_OFFSET "${raw}" is out of range`);
  return sign * (hours * 60 + mins);
}

/** Human label, e.g. +420 => "UTC+07:00" */
export function offsetLabel(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

const workspaceDir = path.resolve(
  PROJECT_ROOT,
  process.env.WORKSPACE_DIR?.trim() || './workspace',
);
const dataDir = path.join(PROJECT_ROOT, 'data');
const timezoneOffsetRaw = process.env.TIMEZONE_OFFSET?.trim() || 'UTC';

/**
 * Base config — safe to import from anywhere (including the standalone `bien` CLI).
 * Contains no secrets and requires no bot-only env vars.
 */
export const config = {
  projectRoot: PROJECT_ROOT,
  timezoneOffsetRaw,
  timezoneOffsetMinutes: parseOffsetMinutes(timezoneOffsetRaw),
  workspaceDir,
  dataDir,
  remindersDir: path.join(workspaceDir, 'reminders'),
  schedulesDir: path.join(workspaceDir, 'schedules'),
  uploadsDir: path.join(workspaceDir, 'uploads'),
  outboxDir: path.join(workspaceDir, 'outbox'),
  agentsFile: path.join(workspaceDir, 'AGENTS.md'),
  sessionsFile: path.join(dataDir, 'sessions.json'),
  rosterFile: path.join(dataDir, 'roster.json'),
  cliPath: path.join(PROJECT_ROOT, 'src', 'cli', 'bien.js'),
  binDir: path.join(PROJECT_ROOT, 'bin'),
  binShim: path.join(PROJECT_ROOT, 'bin', 'bien'),
  pollIntervalMs: optionalInt('POLL_INTERVAL_MS', 60_000),
  nagIntervalMs: optionalInt('NAG_INTERVAL_MS', 300_000),
  nagMax: optionalInt('NAG_MAX', 12),
  aiTimeoutMs: optionalInt('AI_TIMEOUT_MS', 120_000),
  sessionTtlMs: optionalInt('SESSION_TTL_MS', 150_000), // 150s sliding window for active convo
};

/**
 * Bot-only config — validated lazily so the CLI never trips over a missing token.
 * Call once at bot startup (index.js). Throws if any required var is missing/invalid.
 */
export function loadBotConfig() {
  const aiCli = required('AI_CLI').toLowerCase();
  if (!['claude', 'codex'].includes(aiCli)) {
    throw new Error(`AI_CLI must be "claude" or "codex", got "${aiCli}"`);
  }
  // Force a strict parse of the offset now that we're in the bot (surfaces typos early).
  parseOffsetMinutes(required('TIMEZONE_OFFSET'));
  return {
    discordToken: required('DISCORD_TOKEN'),
    aiCli,
    aiModel: required('AI_MODEL'),
  };
}

export default config;
