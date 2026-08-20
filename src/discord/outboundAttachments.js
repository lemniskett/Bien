import fs from 'node:fs/promises';
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const MAX_BYTES = 8 * 1024 * 1024; // 8 MiB — Discord's default (non-boosted) per-file limit
const MAX_FILES = 10; // Discord allows at most 10 attachments per message
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000; // delete generated files older than 24h

// [[attach: ./outbox/chart.png]]  (also accepts `image` as an alias, any spacing/case)
const ATTACH_TOKEN = /\[\[\s*(?:attach|image)\s*:\s*([^\]]+?)\s*\]\]/gi;

/** Best-effort deletion of stale generated files so outbox/ doesn't grow forever. */
export async function pruneOutbox() {
  try {
    const names = await fs.readdir(config.outboxDir);
    const now = Date.now();
    await Promise.all(
      names.map(async (n) => {
        const p = path.join(config.outboxDir, n);
        try {
          const st = await fs.stat(p);
          if (now - st.mtimeMs > PRUNE_AFTER_MS) await fs.unlink(p);
        } catch {
          /* ignore */
        }
      }),
    );
  } catch {
    /* outbox dir may not exist yet */
  }
}

/**
 * Resolve a reply-supplied path to an absolute file inside the workspace.
 * Returns the absolute path, or null if it escapes the workspace / isn't a usable file.
 */
async function resolveInWorkspace(rawPath) {
  // Resolve against the workspace, then follow symlinks, then confirm containment.
  const resolved = path.resolve(config.workspaceDir, rawPath);
  let real;
  try {
    real = await fs.realpath(resolved);
  } catch {
    logger.warn(`[outbound] attachment not found: ${rawPath}`);
    return null;
  }
  const rootReal = await fs.realpath(config.workspaceDir).catch(() => config.workspaceDir);
  const rel = path.relative(rootReal, real);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    logger.warn(`[outbound] rejecting attachment outside workspace: ${rawPath}`);
    return null;
  }
  let st;
  try {
    st = await fs.stat(real);
  } catch {
    return null;
  }
  if (!st.isFile()) {
    logger.warn(`[outbound] attachment is not a regular file: ${rawPath}`);
    return null;
  }
  if (st.size > MAX_BYTES) {
    logger.warn(`[outbound] skipping ${rawPath} (${st.size} bytes > cap)`);
    return null;
  }
  return real;
}

/**
 * Extract [[attach: ...]] tokens from an AI reply, strip them from the visible text,
 * and turn the referenced workspace files into discord.js attachments.
 *
 * @param {string} reply
 * @returns {Promise<{ text: string, files: AttachmentBuilder[] }>}
 */
export async function parseOutbound(reply) {
  const raw = String(reply ?? '');
  const rawPaths = [];
  for (const m of raw.matchAll(ATTACH_TOKEN)) {
    if (m[1]) rawPaths.push(m[1].trim());
  }

  const text = raw
    .replace(ATTACH_TOKEN, '')
    .replace(/[^\S\n]+$/gm, '') // trailing spaces left by a stripped token
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (rawPaths.length === 0) return { text, files: [] };

  const files = [];
  for (const p of rawPaths) {
    if (files.length >= MAX_FILES) {
      logger.warn(`[outbound] attachment cap reached (${MAX_FILES}); dropping ${p}`);
      break;
    }
    const abs = await resolveInWorkspace(p);
    if (!abs) continue;
    files.push(new AttachmentBuilder(abs, { name: path.basename(abs) }));
  }
  if (files.length) {
    logger.info(`[outbound] attaching ${files.length} file(s) to reply`);
    pruneOutbox().catch(() => {});
  }
  return { text, files };
}

export default { parseOutbound, pruneOutbox };
