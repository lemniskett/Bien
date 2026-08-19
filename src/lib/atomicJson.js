import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson(file) {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw);
}

/** Atomic write: temp file in the same dir, then rename over the target. */
export async function writeJsonAtomic(file, obj) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const data = JSON.stringify(obj, null, 2) + '\n';
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, file);
}

/**
 * List every *.json file in dir, returning { id, file, data }.
 * Skips files that fail to parse (logs to stderr) so one bad file can't halt a poll.
 */
export async function listJson(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const data = await readJson(file);
      out.push({ id: path.basename(name, '.json'), file, data });
    } catch (err) {
      console.error(`[atomicJson] skipping unreadable ${file}: ${err.message}`);
    }
  }
  return out;
}

export function newId() {
  return crypto.randomUUID();
}
