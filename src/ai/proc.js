import { spawn } from 'node:child_process';

/**
 * Run a child process to completion, capturing stdout/stderr, with a hard timeout.
 * Resolves { code, stdout, stderr, timedOut }. Never rejects for a non-zero exit.
 */
export function runProcess(bin, args, { cwd, env, timeoutMs = 120_000, input } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const childEnv = { ...process.env, ...env };
      delete childEnv.DISCORD_TOKEN; // AI CLI never needs it; keep it out of injectable reach
      child = spawn(bin, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}
