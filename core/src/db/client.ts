import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export { Prisma } from '../generated/prisma/client.js';
export type { Agent, Session, User } from '../generated/prisma/client.js';

export type Db = PrismaClient;

/**
 * Prisma ORM v7 requires a driver adapter; the pg adapter owns the connection
 * pool. `connectionString` is validated by loadConfig before we get here.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}
