import claude from './claude.js';
import codex from './codex.js';
import { enqueue } from './queue.js';
import { config } from '../config.js';

const ADAPTERS = { claude, codex };

// Put the `bien` shim on the spawned AI's PATH so it can run `bien ...` directly.
const PATH_WITH_BIN = `${config.binDir}:${process.env.PATH ?? ''}`;

/**
 * Create an AI runner bound to the resolved bot config.
 * `run` serializes calls per channel so one session is never invoked concurrently.
 */
export function createRunner({ aiCli, aiModel }) {
  const adapter = ADAPTERS[aiCli];
  if (!adapter) throw new Error(`unknown AI_CLI "${aiCli}"`);

  return {
    /**
     * @param {object} p
     * @param {string} p.prompt   full prompt (context header + message)
     * @param {string} p.channelId session key
     * @param {object} [p.env]     extra env (BIEN_USER_ID/CHANNEL_ID/GUILD_ID)
     * @returns {Promise<string>} the assistant reply text
     */
    run({ prompt, channelId, env }) {
      const fullEnv = { ...env, PATH: PATH_WITH_BIN };
      return enqueue(channelId, () =>
        adapter.run({ prompt, channelId, model: aiModel, env: fullEnv }),
      );
    },
  };
}

export default { createRunner };
