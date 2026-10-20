import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma ORM v7 configures the CLI datasource here (the `url` field in
// `schema.prisma` is deprecated). Client runtime still receives the connection
// string via the pg driver adapter (see src/db/client.ts).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
