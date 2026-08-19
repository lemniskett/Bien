import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { runProcess } from './proc.js';
import { getSession, setSession, clearSession } from './sessionStore.js';

const BIN = process.env.CODEX_BIN || 'codex';

const BOOTSTRAP_PREAMBLE =
  'You are Bien. Read AGENTS.md in this directory and follow it exactly, including your ' +
  'persona and the two structured features. Then handle this message:\n\n';

/** Best-effort: pull a session/conversation id out of the JSONL event stream. */
function findSessionId(stdout) {
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const candidate =
      obj.session_id ||
      obj.conversation_id ||
      obj.conversationId ||
      obj.thread_id ||
      obj?.session?.id ||
      obj?.msg?.session_id ||
      (typeof obj.type === 'string' && /session|thread|configured/i.test(obj.type) ? obj.id : null);
    if (candidate) return String(candidate);
  }
  return null;
}

async function readLast(outFile) {
  try {
    return (await fs.readFile(outFile, 'utf8')).trim();
  } catch {
    return '';
  }
}

const COMMON = ['-C', config.workspaceDir, '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];

export async function run({ prompt, channelId, model, env = {}, timeoutMs = config.aiTimeoutMs }) {
  const outFile = path.join(os.tmpdir(), `bien-codex-${crypto.randomBytes(6).toString('hex')}.txt`);
  let sessionId = await getSession(channelId);

  try {
    if (!sessionId) {
      logger.info(`[codex] bootstrapping session for channel ${channelId}`);
      const args = ['exec', '--json', '-m', model, ...COMMON, '-o', outFile, BOOTSTRAP_PREAMBLE + prompt];
      const { code, stdout, stderr, timedOut } = await runProcess(BIN, args, {
        cwd: config.workspaceDir,
        env,
        timeoutMs,
      });
      if (timedOut) throw new Error(`codex timed out after ${timeoutMs}ms`);
      if (code !== 0) throw new Error(`codex exited ${code}: ${stderr.trim() || stdout.trim()}`);
      const id = findSessionId(stdout);
      if (id) await setSession(channelId, id);
      else logger.warn('[codex] could not capture session id from output; next turn will re-bootstrap');
      return await readLast(outFile);
    }

    const args = ['exec', 'resume', sessionId, '-m', model, ...COMMON, '-o', outFile, prompt];
    const { code, stdout, stderr, timedOut } = await runProcess(BIN, args, {
      cwd: config.workspaceDir,
      env,
      timeoutMs,
    });
    if (timedOut) throw new Error(`codex timed out after ${timeoutMs}ms`);
    if (code !== 0) {
      logger.warn(`[codex] resume failed (exit ${code}: ${stderr.trim()}); re-bootstrapping`);
      await clearSession(channelId);
      return run({ prompt, channelId, model, env, timeoutMs });
    }
    return await readLast(outFile);
  } finally {
    fs.unlink(outFile).catch(() => {});
  }
}

export default { run };
