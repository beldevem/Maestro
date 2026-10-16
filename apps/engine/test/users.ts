import type { SessionUser } from '../src/auth/roles.js';

/** A user holding every role, for tests about other things than permissions. */
export const ADMIN: SessionUser = { id: 'u-admin', email: 'admin@test.local', name: 'Admin', roles: ['pm', 'lead', 'dev'], mustChangePassword: false };
