import process from 'node:process';

// Local unit-only runs may omit PostgreSQL; CI must exercise database isolation.
if (process.env.CI && !process.env.TEST_DATABASE_URL) {
  throw new Error(
    'CI requires TEST_DATABASE_URL; database tests must not skip',
  );
}
