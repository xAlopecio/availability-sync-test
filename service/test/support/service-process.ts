import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const SERVICE_DIR = join(import.meta.dirname, '..', '..');

export type RunningService = {
  readonly process: ChildProcess;
  /** Every stdout line, as written. */
  readonly lines: string[];
  /** Resolves with the base URL once the service logs that it is listening. */
  readonly listening: Promise<string>;
  /** Resolves with the exit code (or the signal) when the process ends. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

/** Starts `node src/main.ts` as a real process on a free port (PORT=0). */
export function startService(env: Record<string, string>): RunningService {
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: SERVICE_DIR,
    // The worker is off unless a test turns it on: process tests must not send portal traffic
    // by accident.
    env: { ...process.env, PORT: '0', LOG_LEVEL: 'info', WORKER_ENABLED: 'false', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  let onListening: (url: string) => void = () => {};
  const listening = new Promise<string>((resolve) => (onListening = resolve));
  let buffer = '';
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      lines.push(line);
      const match = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(line);
      if (match?.[1]) onListening(match[1]);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  return { process: child, lines, listening, exited };
}

/** Parses the JSON log lines; throws on any line that is not JSON. */
export const jsonLines = (lines: readonly string[]) =>
  lines.filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);

export const withTimeout = <T>(promise: Promise<T>, ms: number, what: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out: ${what}`)), ms),
    ),
  ]);
