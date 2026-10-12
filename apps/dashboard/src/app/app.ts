import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Live } from './live';
import { ConfirmHost } from './ui/confirm';
import { Icon } from './ui/icon';
import { ThemeService } from './ui/theme';
import { ToastHost } from './ui/toast';

@Component({
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, ToastHost, ConfirmHost],
  selector: 'app-root',
  templateUrl: './app.html',
})
export class App {
  readonly live = inject(Live);
  readonly theme = inject(ThemeService);
  readonly nav = [
    { path: '/', label: 'Dashboard', icon: 'home' },
    { path: '/projects', label: 'Projects', icon: 'folder' },
    { path: '/agents', label: 'Workers', icon: 'bot' },
    { path: '/pull-requests', label: 'Pull requests', icon: 'pr' },
    { path: '/metrics', label: 'Metrics', icon: 'chart' },
    { path: '/alerts', label: 'Alerts', icon: 'bell' },
    { path: '/settings', label: 'Settings', icon: 'settings' },
  ];

  constructor() {
    this.live.start();
  }
}
