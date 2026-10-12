import { Routes } from '@angular/router';
import { HomePage } from './pages/home';

/** The dashboard loads eagerly; every other page is its own chunk. */
export const routes: Routes = [
  { path: '', pathMatch: 'full', component: HomePage, title: 'Dashboard · Maestro' },
  { path: 'projects', loadComponent: () => import('./pages/projects').then((m) => m.ProjectsPage), title: 'Projects · Maestro' },
  { path: 'projects/:id', loadComponent: () => import('./pages/project').then((m) => m.ProjectPage), title: 'Project · Maestro' },
  { path: 'agents', loadComponent: () => import('./pages/agents').then((m) => m.AgentsPage), title: 'Workers · Maestro' },
  { path: 'pull-requests', loadComponent: () => import('./pages/pull-requests').then((m) => m.PullRequestsPage), title: 'Pull requests · Maestro' },
  { path: 'runs/:id', loadComponent: () => import('./pages/run').then((m) => m.RunPage), title: 'Run · Maestro' },
  { path: 'metrics', loadComponent: () => import('./pages/metrics').then((m) => m.MetricsPage), title: 'Metrics · Maestro' },
  { path: 'alerts', loadComponent: () => import('./pages/alerts').then((m) => m.AlertsPage), title: 'Alerts · Maestro' },
  { path: 'settings', loadComponent: () => import('./pages/settings').then((m) => m.SettingsPage), title: 'Settings · Maestro' },
  { path: '**', redirectTo: '' },
];
