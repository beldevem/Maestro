/**
 * Recovery when nobody can log in: `npm run user:reset -- <email>` (in Docker:
 * `docker compose exec maestro npm run user:reset -- <email>`). Prints a one-time password,
 * unlocks the account and ends its sessions; the person must choose a new password at login.
 * It needs access to this machine, so it can't be used from the web.
 */
import { pathToFileURL } from 'node:url';
import { generatePassword, hashPassword } from './auth/passwords.js';
import { ensureHome, paths } from './config.js';
import { Store } from './db.js';

export async function resetPassword(store: Store, email: string): Promise<{ email: string; password: string }> {
  const u = store.getUserByEmail(email);
  if (!u) throw new Error(`No account with the email ${email}. Accounts: ${store.listUsers().map((x) => x.email).join(', ') || 'none yet (open Maestro to set it up)'}.`);
  const password = generatePassword();
  store.updateUser(u.id, { passwordHash: await hashPassword(password), mustChangePassword: true, failedLogins: 0, lockedUntil: null, deactivatedAt: null });
  store.deleteUserSessions(u.id);
  return { email: u.email, password };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npm run user:reset -- <email>');
    process.exit(2);
  }
  ensureHome();
  const store = new Store(paths.db);
  resetPassword(store, email)
    .then((r) => {
      console.log(`One-time password for ${r.email}: ${r.password}`);
      console.log('Log in with it; Maestro will ask for a new password. Their other sessions were ended.');
      store.close();
    })
    .catch((e: Error) => {
      console.error(e.message);
      store.close();
      process.exit(1);
    });
}
