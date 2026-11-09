export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Every setting of the service (SPEC §8), parsed and validated. */
export type Config = {
  readonly port: number;
  readonly databaseUrl: string;
  readonly logLevel: LogLevel;
  readonly maxUpdateRangeDays: number;
  readonly portal: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly maxRequestsPerMinute: number;
    readonly timeoutMs: number;
  };
  readonly worker: {
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

export function loadConfig(_env: Readonly<Record<string, string | undefined>>): Config {
  throw new Error('not implemented');
}
