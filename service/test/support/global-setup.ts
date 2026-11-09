import { recreateDatabase, TEST_DATABASE } from './test-db.ts';

/** Runs once before the integration suite: a clean `sync_test` database (T1). */
export default async function setup(): Promise<void> {
  await recreateDatabase(TEST_DATABASE);
}
