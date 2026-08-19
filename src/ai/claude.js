import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { runProcess } from './proc.js';
import { getSession, setSession, clearSession } from './sessionStore.js';

const BIN = process.env.CLAUDE_BIN || 'claude';

const BOOTSTRAP_PREAMBLE =
  'You are Bien. Read AGENTS.md in this directory and follow it exactly, including your ' +
  'persona and the two structured features. Then handle this message:\n\n';

function parseResult(stdout) {
  const trimmed = stdout.trim();
  // --output-format json prints a single JSON object.
  const obj = JSON.parse(trimmed);
  // Claude signals model/auth errors via is_error even with exit code 0.
  if (obj.is_error) {
    const msg = obj.result || obj.error || 'unknown error';
    const err = new Error(`claude error: ${msg}`);
    err.claudeError = true;
    throw err;
  }
  return { reply: obj.result ?? obj.response ?? '', sessionId: obj.session_id ?? null };
}

async function invoke(args, env, timeoutMs) {
  const { code, stdout, stderr, timedOut } = await runProcess(BIN, args, {
    cwd: config.workspaceDir,
    env,
    timeoutMs,
  });
  if (timedOut) throw new Error(`claude timed out after ${timeoutMs}ms`);
  const out = stdout.trim();
  if (out.startsWith('{')) return parseResult(out); // parse JSON even on non-zero exit (cleaner errors)
  if (code !== 0) throw new Error(`claude exited ${code}: ${stderr.trim() || out}`);
  throw new Error(`claude produced no JSON output: ${out || stderr.trim()}`);
}

/**
 * Run one turn against the channel's persistent session.
 * Bootstraps a new session (reading AGENTS.md) if none exists; resumes otherwise.
 */
export async function run({ prompt, channelId, model, env = {}, timeoutMs = config.aiTimeoutMs }) {
  const base = ['-p', '--model', model, '--dangerously-skip-permissions', '--output-format', 'json'];
  let sessionId = await getSession(channelId);

  if (!sessionId) {
    const newId = crypto.randomUUID();
    logger.info(`[claude] bootstrapping session ${newId} for channel ${channelId}`);
    const args = ['--session-id', newId, ...base, BOOTSTRAP_PREAMBLE + prompt];
    const out = await invoke(args, env, timeoutMs);
    await setSession(channelId, out.sessionId || newId);
    return out.reply;
  }

  try {
    const args = ['--resume', sessionId, ...base, prompt];
    const out = await invoke(args, env, timeoutMs);
    // Defensive: persist the id claude reports (in case a version forks on resume).
    if (out.sessionId && out.sessionId !== sessionId) await setSession(channelId, out.sessionId);
    return out.reply;
  } catch (err) {
    // A model/auth error isn't a session problem — surface it, don't loop.
    if (err.claudeError) throw err;
    // Session lost/corrupt → fall back to a fresh bootstrap.
    logger.warn(`[claude] resume failed (${err.message}); re-bootstrapping channel ${channelId}`);
    await clearSession(channelId);
    return run({ prompt, channelId, model, env, timeoutMs });
  }
}

export default { run };
