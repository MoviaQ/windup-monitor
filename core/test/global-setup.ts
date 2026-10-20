import { execFileSync } from 'node:child_process';

/**
 * Applies migrations to the test database before the suite runs. Tests require
 * a real PostgreSQL instance (integration tests, no mocks).
 */
export default function globalSetup(): void {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL must be set for integration tests (see scripts/dev-db.sh)');
  }
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: process.env,
  });
}
