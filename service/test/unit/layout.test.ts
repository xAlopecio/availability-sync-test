import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the layout in SPEC §3: a test file anywhere else would silently never run.
const SERVICE = join(import.meta.dirname, '..', '..');
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]s$/;
const RUNNABLE = ['unit', 'integration', 'e2e'];

const testFilesUnder = (dir: string) =>
  readdirSync(join(SERVICE, dir), { recursive: true, encoding: 'utf8' })
    .filter((path) => TEST_FILE.test(path))
    .map((path) => join(dir, path));

describe('source layout', () => {
  it('has no test files inside src/ (tests live in test/)', () => {
    expect(testFilesUnder('src')).toEqual([]);
  });

  it('has every test file in a folder that a Vitest project runs', () => {
    const stray = testFilesUnder('test').filter(
      (path) => !RUNNABLE.includes(relative('test', path).split(sep)[0] ?? ''),
    );
    expect(stray).toEqual([]);
  });
});
