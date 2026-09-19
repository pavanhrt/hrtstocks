// Invite a person (invite-only sign-in). Never sends e-mail.
//
//   node --env-file=.env.local scripts/invite-user.ts --email person@example.com --role researcher [--reset-link]
//
// Needs DATABASE_URL (or a Cloud SQL connection) and Firebase Admin access (Application Default
// Credentials, or the Auth emulator via FIREBASE_AUTH_EMULATOR_HOST). --reset-link prints a one-time
// link for YOU to deliver to the person; the link is a credential: treat it like a password.
import { closeDb, getDb } from "../src/lib/db/pool.ts";
import { adminAuth } from "../src/lib/firebase/admin.ts";
import { inviteUser } from "../src/lib/invite.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const email = arg("email");
const role = arg("role") ?? "viewer";
if (!email) {
  console.error("Usage: node scripts/invite-user.ts --email <address> [--role viewer|researcher|strategy_admin|system_admin] [--reset-link]");
  process.exit(2);
}

try {
  const result = await inviteUser(getDb(), adminAuth(), { email, role, includeResetLink: process.argv.includes("--reset-link") });
  console.log(`${result.createdAccount ? "Created" : "Found existing"} account for ${email.toLowerCase()}; role=${role}; profile=${result.profileId}`);
  if (result.resetLink) console.log(`One-time password link (deliver privately):\n${result.resetLink}`);
  else console.log("No e-mail was sent. Re-run with --reset-link to obtain a link to deliver.");
} catch (err) {
  console.error(`Failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
