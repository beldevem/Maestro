import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { Rights } from './rights';
import { Session } from './session';

/** Pages of the app: need a session, and a chosen password. */
export const signedIn: CanActivateFn = async (_route, state) => {
  const session = inject(Session);
  const router = inject(Router);
  await session.load();
  if (session.setupNeeded()) return router.createUrlTree(['/setup']);
  const u = session.user();
  if (!u) return router.createUrlTree(['/login'], { queryParams: state.url && state.url !== '/' ? { next: state.url } : {} });
  if (u.mustChangePassword) return router.createUrlTree(['/password']);
  return true;
};

/** Login and setup: only while logged out (and setup only before the first account). */
export const signedOut: CanActivateFn = async (route) => {
  const session = inject(Session);
  const router = inject(Router);
  await session.load();
  const setup = route.routeConfig?.path === 'setup';
  if (setup !== session.setupNeeded()) return router.createUrlTree([setup ? '/login' : '/setup']);
  if (session.user()) return router.createUrlTree(['/']);
  return true;
};

/** The change-password page: any logged-in user. */
export const hasSession: CanActivateFn = async () => {
  const session = inject(Session);
  await session.load();
  return session.user() ? true : inject(Router).createUrlTree(['/login']);
};

/** A page only for people with `action` (e.g. Settings for Tech Leads); others go to the Dashboard. */
export const allowed = (action: string): CanActivateFn => async () => {
  const rights = inject(Rights);
  await rights.load();
  return rights.can(action) ? true : inject(Router).createUrlTree(['/']);
};
