export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Every setting of the service (SPEC §8), parsed and validated. */
export type Config = {
  readonly port: number;
  readonly databaseUrl: string;
  /** How long startup keeps retrying an unreachable database before exiting (SPEC §8). */
  readonly databaseStartupTimeoutMs: number;
  /** How long SIGTERM waits for in-flight work before forcing the exit (SPEC §8). */
  readonly shutdownGraceMs: number;
  readonly logLevel: LogLevel;
  readonly maxUpdateRangeDays: number;
  readonly portal: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly maxRequestsPerMinute: number;
    readonly timeoutMs: number;
    /** D9: hold an accommodation's next tasks this long after a timed-out attempt. */
    readonly timeoutSettleMs: number;
  };
  readonly worker: {
    /** `false` runs the API only (SPEC §8). */
    readonly enabled: boolean;
    readonly concurrency: number;
    readonly leaseMs: number;
    readonly pollMs: number;
  };
  readonly retry: { readonly baseMs: number; readonly maxMs: number };
};

/** Thrown when the environment is invalid; lists every problem at once. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env): Config {
  const problems: string[] = [];

  const int = (name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
      problems.push(`${name} must be an integer from ${min} to ${max}, got ${JSON.stringify(raw)}`);
      return fallback;
    }
    return Number(raw);
  };

  const bool = (name: string, fallback: boolean) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (raw !== 'true' && raw !== 'false') {
      problems.push(`${name} must be "true" or "false", got ${JSON.stringify(raw)}`);
      return fallback;
    }
    return raw === 'true';
  };

  const url = (name: string, fallback: string, protocols: readonly string[]) => {
    const raw = env[name] ?? fallback;
    let parsed: URL | undefined;
    try {
      parsed = new URL(raw);
    } catch {
      parsed = undefined;
    }
    if (!parsed || !protocols.includes(parsed.protocol)) {
      problems.push(`${name} must be a ${protocols.join(' or ')} URL, got ${JSON.stringify(raw)}`);
      return fallback;
    }
    return raw.replace(/\/+$/, '');
  };

  // 0 is valid: the OS picks a free port (the process tests rely on it).
  const port = int('PORT', 3000, 0, 65535);
  const databaseUrl = url('DATABASE_URL', 'postgres://sync:sync@localhost:5432/sync', [
    'postgres:',
    'postgresql:',
  ]);
  const baseUrl = url('PORTAL_BASE_URL', 'http://localhost:4000', ['http:', 'https:']);

  const apiKey = env['PORTAL_API_KEY'] ?? 'sol-demo-key';
  if (apiKey === '') problems.push('PORTAL_API_KEY must not be empty');

  const logLevel = env['LOG_LEVEL'] ?? 'info';
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    problems.push(
      `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got ${JSON.stringify(logLevel)}`,
    );
  }

  const timeoutMs = int('PORTAL_TIMEOUT_MS', 5000);
  const leaseMs = int('TASK_LEASE_MS', 30000);
  const retryBaseMs = int('RETRY_BASE_MS', 1000);
  const retryMaxMs = int('RETRY_MAX_MS', 300000);
  const config: Config = {
    port,
    databaseUrl,
    databaseStartupTimeoutMs: int('DATABASE_STARTUP_TIMEOUT_MS', 30000),
    shutdownGraceMs: int('SHUTDOWN_GRACE_MS', 10000),
    logLevel: logLevel as LogLevel,
    maxUpdateRangeDays: int('MAX_UPDATE_RANGE_DAYS', 366),
    portal: {
      baseUrl,
      apiKey,
      maxRequestsPerMinute: int('PORTAL_MAX_REQUESTS_PER_MINUTE', 25),
      timeoutMs,
      timeoutSettleMs: int('PORTAL_TIMEOUT_SETTLE_MS', 30000),
    },
    worker: {
      enabled: bool('WORKER_ENABLED', true),
      concurrency: int('WORKER_CONCURRENCY', 3),
      leaseMs,
      pollMs: int('WORKER_POLL_MS', 500),
    },
    retry: { baseMs: retryBaseMs, maxMs: retryMaxMs },
  };

  // A lease shorter than the request would let another slot claim a task still in flight (D6).
  if (leaseMs <= timeoutMs) {
    problems.push(
      `TASK_LEASE_MS (${leaseMs}) must be greater than PORTAL_TIMEOUT_MS (${timeoutMs})`,
    );
  }
  if (retryMaxMs < retryBaseMs) {
    problems.push(`RETRY_MAX_MS (${retryMaxMs}) must not be below RETRY_BASE_MS (${retryBaseMs})`);
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return deepFreeze(config);
}

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) deepFreeze(child);
  }
  return Object.freeze(value);
}
