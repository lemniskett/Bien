import fs from 'node:fs/promises';
import { config } from './config.js';

/** Create workspace/data dirs if missing. */
export async function ensureDirs() {
  for (const dir of [
    config.workspaceDir,
    config.remindersDir,
    config.schedulesDir,
    config.uploadsDir,
    config.dataDir,
    config.binDir,
  ]) {
    await fs.mkdir(dir, { recursive: true });
  }
}

/** Write the `bien` shell shim (so the AI can invoke `bien ...` via PATH). */
export async function ensureBinShim() {
  const shim = `#!/bin/sh\nexec node "${config.cliPath}" "$@"\n`;
  await fs.writeFile(config.binShim, shim, { mode: 0o755 });
  await fs.chmod(config.binShim, 0o755);
}

export async function runStartupTasks() {
  await ensureDirs();
  await ensureBinShim();
}

export default { ensureDirs, ensureBinShim, runStartupTasks };
