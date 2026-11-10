import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '#src/config.ts';

function problemsOf(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected loadConfig to throw a ConfigError');
}

describe('loadConfig', () => {
  it('K1: an empty environment gives every SPEC §8 default', () => {
    expect(loadConfig({})).toEqual({
      port: 3000,
      databaseUrl: 'postgres://sync:sync@localhost:5432/sync',
      databaseStartupTimeoutMs: 30000,
      shutdownGraceMs: 10000,
      logLevel: 'info',
      maxUpdateRangeDays: 366,
      portal: {
        baseUrl: 'http://localhost:4000',
        apiKey: 'sol-demo-key',
        maxRequestsPerMinute: 25,
        timeoutMs: 5000,
        timeoutSettleMs: 30000,
      },
      worker: { enabled: true, concurrency: 3, leaseMs: 30000, pollMs: 500 },
      retry: { baseMs: 1000, maxMs: 300000 },
    });
  });

  it('K2: every variable can be overridden', () => {
    expect(
      loadConfig({
        PORT: '8080',
        DATABASE_URL: 'postgres://u:p@db:5432/other',
        DATABASE_STARTUP_TIMEOUT_MS: '1500',
        SHUTDOWN_GRACE_MS: '2000',
        LOG_LEVEL: 'debug',
        MAX_UPDATE_RANGE_DAYS: '90',
        PORTAL_BASE_URL: 'https://portal.example.com',
        PORTAL_API_KEY: 'secret',
        PORTAL_MAX_REQUESTS_PER_MINUTE: '10',
        PORTAL_TIMEOUT_MS: '2000',
        WORKER_CONCURRENCY: '1',
        TASK_LEASE_MS: '10000',
        WORKER_POLL_MS: '100',
        WORKER_ENABLED: 'false',
        PORTAL_TIMEOUT_SETTLE_MS: '3000',
        RETRY_BASE_MS: '500',
        RETRY_MAX_MS: '60000',
      }),
    ).toEqual({
      port: 8080,
      databaseUrl: 'postgres://u:p@db:5432/other',
      databaseStartupTimeoutMs: 1500,
      shutdownGraceMs: 2000,
      logLevel: 'debug',
      maxUpdateRangeDays: 90,
      portal: {
        baseUrl: 'https://portal.example.com',
        apiKey: 'secret',
        maxRequestsPerMinute: 10,
        timeoutMs: 2000,
        timeoutSettleMs: 3000,
      },
      worker: { enabled: false, concurrency: 1, leaseMs: 10000, pollMs: 100 },
      retry: { baseMs: 500, maxMs: 60000 },
    });
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', ''],
    ['PORT', '70000'],
    ['WORKER_CONCURRENCY', '0'],
    ['WORKER_CONCURRENCY', '1.5'],
    ['PORTAL_TIMEOUT_MS', '-1'],
    ['PORTAL_MAX_REQUESTS_PER_MINUTE', '0'],
    ['RETRY_BASE_MS', '0'],
    ['WORKER_POLL_MS', 'fast'],
    ['MAX_UPDATE_RANGE_DAYS', '0'],
    ['PORTAL_API_KEY', ''],
    ['DATABASE_STARTUP_TIMEOUT_MS', '0'],
    ['SHUTDOWN_GRACE_MS', '0'],
    ['PORTAL_TIMEOUT_SETTLE_MS', 'x'],
    ['WORKER_ENABLED', 'yes'],
    ['WORKER_ENABLED', '1'],
  ])('K3: rejects %s=%j, naming the variable', (name, value) => {
    const problems = problemsOf({ [name]: value });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(name);
  });

  it('K3: reports every invalid variable at once', () => {
    const problems = problemsOf({ PORT: 'abc', WORKER_CONCURRENCY: '0', LOG_LEVEL: 'loud' });
    expect(problems).toHaveLength(3);
    for (const name of ['PORT', 'WORKER_CONCURRENCY', 'LOG_LEVEL']) {
      expect(problems.some((p) => p.includes(name))).toBe(true);
    }
  });

  it('K3: the thrown error is a ConfigError whose message lists the problems', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
  });

  it.each(['not a url', 'ftp://portal:4000', ''])('K4: rejects PORTAL_BASE_URL=%j', (value) => {
    expect(problemsOf({ PORTAL_BASE_URL: value })[0]).toContain('PORTAL_BASE_URL');
  });

  it.each([
    ['http://x:4000/', 'http://x:4000'],
    ['http://x:4000//', 'http://x:4000'],
    ['https://portal.example.com/base/', 'https://portal.example.com/base'],
  ])('K4: normalises PORTAL_BASE_URL %s → %s', (value, expected) => {
    expect(loadConfig({ PORTAL_BASE_URL: value }).portal.baseUrl).toBe(expected);
  });

  it.each(['mysql://u:p@db/x', 'not a url'])('K4: rejects DATABASE_URL=%j', (value) => {
    expect(problemsOf({ DATABASE_URL: value })[0]).toContain('DATABASE_URL');
  });

  it('K5 / D6: TASK_LEASE_MS must be greater than PORTAL_TIMEOUT_MS', () => {
    expect(problemsOf({ TASK_LEASE_MS: '5000', PORTAL_TIMEOUT_MS: '5000' })[0]).toMatch(
      /TASK_LEASE_MS.*PORTAL_TIMEOUT_MS/,
    );
    expect(loadConfig({ TASK_LEASE_MS: '5001', PORTAL_TIMEOUT_MS: '5000' }).worker.leaseMs).toBe(
      5001,
    );
  });

  it('K5: RETRY_MAX_MS must not be below RETRY_BASE_MS', () => {
    expect(problemsOf({ RETRY_BASE_MS: '2000', RETRY_MAX_MS: '1000' })[0]).toMatch(
      /RETRY_MAX_MS.*RETRY_BASE_MS/,
    );
  });

  it.each(['loud', 'INFO', ''])('K6: rejects LOG_LEVEL=%j', (value) => {
    expect(problemsOf({ LOG_LEVEL: value })[0]).toContain('LOG_LEVEL');
  });

  it('K7: allows PORTAL_MAX_REQUESTS_PER_MINUTE above 30 (AC6 provokes 429s on purpose)', () => {
    expect(loadConfig({ PORTAL_MAX_REQUESTS_PER_MINUTE: '120' }).portal.maxRequestsPerMinute).toBe(
      120,
    );
  });

  it('K2: PORT=0 is allowed (the OS picks a free port)', () => {
    expect(loadConfig({ PORT: '0' }).port).toBe(0);
  });

  it('K8: MAX_UPDATE_RANGE_DAYS defaults to 366 and can be overridden', () => {
    expect(loadConfig({}).maxUpdateRangeDays).toBe(366);
    expect(loadConfig({ MAX_UPDATE_RANGE_DAYS: '31' }).maxUpdateRangeDays).toBe(31);
  });

  it('returns a frozen object', () => {
    const config = loadConfig({});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.portal)).toBe(true);
  });
});
