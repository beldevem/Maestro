import { Routes } from '@angular/router';
import { hasSession, signedIn, signedOut } from './guards';
import { HomePage } from './pages/home';
import { LoginPage } from './pages/login';

/** The dashboard loads eagerly; every other page is its own chunk. */
export const routes: Routes = [
  { path: 'login', component: LoginPage, canActivate: [signedOut], title: 'Log in · Maestro' },
  { path: 'setup', component: LoginPage, canActivate: [signedOut], data: { setup: true }, title: 'Set up · Maestro' },
  { path: 'password', loadComponent: () => import('./pages/password').then((m) => m.PasswordPage), canActivate: [hasSession], title: 'Password · Maestro' },
  { path: '', pathMatch: 'full', component: HomePage, canActivate: [signedIn], title: 'Dashboard · Maestro' },
  { path: 'projects', loadComponent: () => import('./pages/projects').then((m) => m.ProjectsPage), canActivate: [signedIn], title: 'Projects · Maestro' },
  { path: 'projects/:id', loadComponent: () => import('./pages/project').then((m) => m.ProjectPage), canActivate: [signedIn], title: 'Project · Maestro' },
  { path: 'agents', loadComponent: () => import('./pages/agents').then((m) => m.AgentsPage), canActivate: [signedIn], title: 'Workers · Maestro' },
  { path: 'pull-requests', loadComponent: () => import('./pages/pull-requests').then((m) => m.PullRequestsPage), canActivate: [signedIn], title: 'Pull requests · Maestro' },
  { path: 'runs/:id', loadComponent: () => import('./pages/run').then((m) => m.RunPage), canActivate: [signedIn], title: 'Run · Maestro' },
  { path: 'metrics', loadComponent: () => import('./pages/metrics').then((m) => m.MetricsPage), canActivate: [signedIn], title: 'Metrics · Maestro' },
  { path: 'alerts', loadComponent: () => import('./pages/alerts').then((m) => m.AlertsPage), canActivate: [signedIn], title: 'Alerts · Maestro' },
  { path: 'settings', loadComponent: () => import('./pages/settings').then((m) => m.SettingsPage), canActivate: [signedIn], title: 'Settings · Maestro' },
  { path: '**', redirectTo: '' },
];
