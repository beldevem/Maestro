import { Routes } from '@angular/router';
import { AgentsPage } from './pages/agents';
import { HomePage } from './pages/home';
import { ProjectPage } from './pages/project';
import { ProjectsPage } from './pages/projects';
import { AlertsPage } from './pages/alerts';
import { MetricsPage } from './pages/metrics';
import { PullRequestsPage } from './pages/pull-requests';
import { RunPage } from './pages/run';
import { SettingsPage } from './pages/settings';

export const routes: Routes = [
  { path: '', pathMatch: 'full', component: HomePage, title: 'Dashboard · Maestro' },
  { path: 'projects', component: ProjectsPage, title: 'Projects · Maestro' },
  { path: 'projects/:id', component: ProjectPage, title: 'Project · Maestro' },
  { path: 'agents', component: AgentsPage, title: 'Workers · Maestro' },
  { path: 'pull-requests', component: PullRequestsPage, title: 'Pull requests · Maestro' },
  { path: 'runs/:id', component: RunPage, title: 'Run · Maestro' },
  { path: 'metrics', component: MetricsPage, title: 'Metrics · Maestro' },
  { path: 'alerts', component: AlertsPage, title: 'Alerts · Maestro' },
  { path: 'settings', component: SettingsPage, title: 'Settings · Maestro' },
  { path: '**', redirectTo: '' },
];
