import { Routes } from '@angular/router';
import { AgentsPage } from './pages/agents';
import { ProjectPage } from './pages/project';
import { ProjectsPage } from './pages/projects';
import { RunPage } from './pages/run';
import { SettingsPage } from './pages/settings';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'agents' },
  { path: 'projects', component: ProjectsPage, title: 'Projects · Maestro' },
  { path: 'projects/:id', component: ProjectPage, title: 'Project · Maestro' },
  { path: 'agents', component: AgentsPage, title: 'Agents · Maestro' },
  { path: 'runs/:id', component: RunPage, title: 'Run · Maestro' },
  { path: 'settings', component: SettingsPage, title: 'Settings · Maestro' },
  { path: '**', redirectTo: 'agents' },
];
