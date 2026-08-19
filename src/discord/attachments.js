import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

const MAX_BYTES = 20 * 1024 * 1024; // 20MB safety cap per image
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000; // delete downloaded images older than 24h
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;

function isImage(att) {
  if (att.contentType && att.contentType.startsWith('image/')) return true;
  return IMAGE_EXT.test(att.name || '');
}

function safeName(name) {
  return (name || 'image').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
}

/** Best-effort deletion of stale downloaded images so the folder doesn't grow forever. */
export async function pruneUploads() {
  try {
    const names = await fs.readdir(config.uploadsDir);
    const now = Date.now();
    await Promise.all(
      names.map(async (n) => {
        const p = path.join(config.uploadsDir, n);
        try {
          const st = await fs.stat(p);
          if (now - st.mtimeMs > PRUNE_AFTER_MS) await fs.unlink(p);
        } catch {
          /* ignore */
        }
      }),
    );
  } catch {
    /* uploads dir may not exist yet */
  }
}

/**
 * Download image attachments from a Discord message into workspace/uploads/.
 * Returns [{ rel, name }] where `rel` is a workspace-relative path the AI can read.
 */
export async function downloadImages(message) {
  const atts = [...(message.attachments?.values?.() ?? [])].filter(isImage);
  if (atts.length === 0) return [];

  await fs.mkdir(config.uploadsDir, { recursive: true });
  pruneUploads().catch(() => {});

  const out = [];
  for (const att of atts) {
    try {
      if (att.size && att.size > MAX_BYTES) {
        logger.warn(`[images] skipping ${att.name} (${att.size} bytes > cap)`);
        continue;
      }
      const res = await fetch(att.url);
      if (!res.ok) {
        logger.warn(`[images] fetch failed for ${att.name}: HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) continue;
      const fname = `${message.id}-${safeName(att.name)}`;
      await fs.writeFile(path.join(config.uploadsDir, fname), buf);
      out.push({ rel: `./uploads/${fname}`, name: att.name || fname });
    } catch (err) {
      logger.warn(`[images] error downloading ${att.name}: ${err.message}`);
    }
  }
  if (out.length) logger.info(`[images] saved ${out.length} image(s) for message ${message.id}`);
  return out;
}

export default { downloadImages, pruneUploads };
