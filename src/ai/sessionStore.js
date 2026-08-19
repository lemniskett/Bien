import { config } from '../config.js';
import { readJson, writeJsonAtomic } from '../lib/atomicJson.js';

let cache = null;

async function load() {
  if (cache) return cache;
  try {
    cache = await readJson(config.sessionsFile);
  } catch (err) {
    if (err.code === 'ENOENT') cache = {};
    else throw err;
  }
  return cache;
}

export async function getSession(channelId) {
  const map = await load();
  return map[channelId] ?? null;
}

export async function setSession(channelId, sessionId) {
  const map = await load();
  map[channelId] = sessionId;
  await writeJsonAtomic(config.sessionsFile, map);
}

export async function clearSession(channelId) {
  const map = await load();
  delete map[channelId];
  await writeJsonAtomic(config.sessionsFile, map);
}
