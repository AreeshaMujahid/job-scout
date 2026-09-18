/**
 * Apply the schema to whatever database DATABASE_URL / PGLITE_DIR points at.
 *
 *   npx tsx scripts/migrate.ts
 *
 * The app migrates itself on boot, so this exists for the cases where boot is
 * the wrong moment: bringing a fresh Postgres up in Docker before the first
 * request, and creating a throwaway database to test against.
 */
import { getDb } from "@/lib/db";

async function main(): Promise<void> {
  // getDb() runs the DDL; there is nothing else to do.
  await getDb();
  const target = process.env.DATABASE_URL ? "Postgres" : (process.env.PGLITE_DIR ?? "./.pglite");
  console.log(`schema applied to ${target}`);
  process.exit(0);
}

void main();
