import { createHash, randomBytes } from 'node:crypto';
import type { Store, UserRow } from '../db.js';
import { hashPassword, passwordProblem, verifyPassword } from './passwords.js';
import type { Role, SessionUser } from './roles.js';

export const COOKIE = 'maestro_session';
/** A session ends after 7 days without use, and 30 days after login at most. */
export const IDLE_MS = 7 * 86_400_000;
export const ABSOLUTE_MS = 30 * 86_400_000;
/** 5 wrong passwords lock the account for 15 minutes. */
export const MAX_FAILED = 5;
export const LOCK_MS = 15 * 60_000;
/** Login attempts per address, whatever the account, in a 15-minute window. */
export const MAX_ATTEMPTS_PER_ADDRESS = 30;

const hashId = (id: string) => createHash('sha256').update(id).digest('hex');

export const sessionUser = (u: UserRow): SessionUser => ({ id: u.id, email: u.email, name: u.name, roles: u.roles, mustChangePassword: u.mustChangePassword });

export class AuthError extends Error {
  constructor(message: string, readonly statusCode = 401, readonly code = 'unauthorized') {
    super(message);
  }
}

export class Auth {
  private attempts = new Map<string, number[]>();

  constructor(private readonly store: Store, private readonly clock: () => number = Date.now) {}

  /** Starts a session; returns the cookie's value (only its hash is stored). */
  startSession(userId: string, userAgent: string | null): string {
    const id = randomBytes(32).toString('base64url');
    const now = this.clock();
    this.store.createSession(hashId(id), userId, new Date(now + ABSOLUTE_MS).toISOString(), userAgent?.slice(0, 200) ?? null, new Date(now).toISOString());
    return id;
  }

  /** The user behind a cookie, or null when the session is unknown, idle too long, past its end, or the user was deactivated. */
  resolve(cookieId: string | undefined): { user: SessionUser; idHash: string } | null {
    if (!cookieId) return null;
    const idHash = hashId(cookieId);
    const s = this.store.getSession(idHash);
    if (!s) return null;
    const now = this.clock();
    if (Date.parse(s.expiresAt) <= now || Date.parse(s.lastSeenAt) + IDLE_MS <= now) {
      this.store.deleteSession(idHash);
      return null;
    }
    const u = this.store.getUser(s.userId);
    if (!u || u.deactivatedAt) {
      this.store.deleteSession(idHash);
      return null;
    }
    // Refresh the idle clock at most once a minute.
    if (now - Date.parse(s.lastSeenAt) > 60_000) this.store.touchSession(idHash, new Date(now).toISOString());
    return { user: sessionUser(u), idHash };
  }

  endSession(cookieId: string | undefined): void {
    if (cookieId) this.store.deleteSession(hashId(cookieId));
  }

  idHash(cookieId: string): string {
    return hashId(cookieId);
  }

  private limitAddress(address: string): void {
    const now = this.clock();
    const recent = (this.attempts.get(address) ?? []).filter((t) => now - t < LOCK_MS);
    recent.push(now);
    this.attempts.set(address, recent);
    if (recent.length > MAX_ATTEMPTS_PER_ADDRESS) throw new AuthError('Too many login attempts from this address. Wait 15 minutes and try again.', 429, 'rate_limited');
  }

  /** Checks a login. Wrong passwords count toward a lockout; the message never says whether the email exists. */
  async login(email: string, password: string, address: string): Promise<UserRow> {
    this.limitAddress(address);
    const u = this.store.getUserByEmail(email);
    const wrong = new AuthError('Wrong email or password.', 401, 'bad_credentials');
    if (!u || u.deactivatedAt) {
      // Same work as a real check, so timing doesn't reveal which emails exist.
      await verifyPassword(password, 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
      throw wrong;
    }
    const now = this.clock();
    if (u.lockedUntil && Date.parse(u.lockedUntil) > now) {
      throw new AuthError(`Too many wrong passwords. This account is locked until ${new Date(u.lockedUntil).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`, 423, 'locked');
    }
    if (!(await verifyPassword(password, u.passwordHash))) {
      const failed = u.failedLogins + 1;
      const lock = failed >= MAX_FAILED;
      this.store.updateUser(u.id, { failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(now + LOCK_MS).toISOString() : null });
      if (lock) throw new AuthError('Too many wrong passwords. This account is locked for 15 minutes.', 423, 'locked');
      throw wrong;
    }
    return this.store.updateUser(u.id, { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date(now).toISOString() })!;
  }

  /** Creates an account; the caller decides who may. */
  async createUser(input: { email: string; name: string; password: string; roles: Role[]; mustChangePassword?: boolean }): Promise<UserRow> {
    const problem = passwordProblem(input.password);
    if (problem) throw new AuthError(problem, 400, 'weak_password');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) throw new AuthError('Enter a valid email address.', 400, 'bad_email');
    if (!input.name.trim()) throw new AuthError('Enter a name.', 400, 'bad_name');
    if (this.store.getUserByEmail(input.email)) throw new AuthError('An account with this email already exists.', 409, 'email_taken');
    return this.store.createUser({ ...input, passwordHash: await hashPassword(input.password) });
  }

  /** Sets a new password and ends the user's other sessions (all of them when `keep` is not given). */
  async setPassword(userId: string, password: string, opts: { mustChange?: boolean; keepSession?: string } = {}): Promise<void> {
    const problem = passwordProblem(password);
    if (problem) throw new AuthError(problem, 400, 'weak_password');
    this.store.updateUser(userId, { passwordHash: await hashPassword(password), mustChangePassword: !!opts.mustChange, failedLogins: 0, lockedUntil: null });
    this.store.deleteUserSessions(userId, opts.keepSession);
  }
}

/** Reads one cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function sessionCookie(value: string, secure: boolean, maxAgeSeconds = ABSOLUTE_MS / 1000): string {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeSeconds)}${secure ? '; Secure' : ''}`;
}

export const clearedCookie = (secure: boolean) => sessionCookie('', secure, 0);
