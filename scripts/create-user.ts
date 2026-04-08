/**
 * Create a user in the database.
 * Usage: npx tsx scripts/create-user.ts <username> <password>
 *
 * For production (Turso), set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN env vars.
 * For local dev, it uses the SQLite file in data/.
 */

import { createUser, getUserByUsername, getUserCount } from "../src/lib/database";
import { hashPassword } from "../src/lib/auth";

async function main() {
  const [username, password] = process.argv.slice(2);

  if (!username || !password) {
    console.error("Usage: npx tsx scripts/create-user.ts <username> <password>");
    console.error("  Password must be at least 8 characters.");
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("Error: Password must be at least 8 characters.");
    process.exit(1);
  }

  const existing = await getUserByUsername(username);
  if (existing) {
    console.error(`Error: User "${username}" already exists.`);
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const id = await createUser(username, hash);
  const total = await getUserCount();

  console.log(`User "${username}" created (id: ${id}). Total users: ${total}.`);
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
