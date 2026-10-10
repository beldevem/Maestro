import { Component, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Project } from '../models';

export type ConnectorModel = Pick<Project, 'codeHost' | 'pm' | 'design'>;

export function emptyConnectors(): ConnectorModel {
  return {
    codeHost: { provider: 'github', repo: '', localPath: '', defaultBranch: 'main' },
    pm: { provider: 'manual', settings: {} },
    design: { provider: 'none', settings: {} },
  };
}

/** Code host, PM tool and design tool choices for a project. Edits the model in place. */
@Component({
  selector: 'app-connector-fields',
  imports: [FormsModule],
  template: `
    @let m = model();
    <fieldset>
      <legend>Code host</legend>
      <label>Provider
        <select [(ngModel)]="m.codeHost.provider" name="ch-provider">
          <option value="github">GitHub</option>
          <option value="local">Local folder on this machine</option>
          <option value="gitlab" disabled>GitLab (coming)</option>
          <option value="bitbucket" disabled>Bitbucket (coming)</option>
        </select>
      </label>
      @if (m.codeHost.provider === 'github') {
        <label>Repository <input [(ngModel)]="m.codeHost.repo" name="ch-repo" placeholder="owner/name" required /></label>
      } @else {
        <label>Folder path <input [(ngModel)]="m.codeHost.localPath" name="ch-path" placeholder="/home/you/projects/app" required /></label>
      }
      <label>Default branch <input [(ngModel)]="m.codeHost.defaultBranch" name="ch-branch" /></label>
    </fieldset>

    <fieldset>
      <legend>Project management</legend>
      <label>Tickets live in
        <select [(ngModel)]="m.pm.provider" name="pm-provider" (ngModelChange)="m.pm.settings = {}">
          <option value="jira">Jira</option>
          <option value="trello">Trello</option>
          <option value="manual">Maestro (no PM tool)</option>
        </select>
      </label>
      @if (m.pm.provider === 'jira') {
        <label>Site URL <input [(ngModel)]="m.pm.settings['baseUrl']" name="jira-url" placeholder="https://your-team.atlassian.net" /></label>
        <label>Project key <input [(ngModel)]="m.pm.settings['projectKey']" name="jira-key" placeholder="MAE" /></label>
        <label>Account email <input [(ngModel)]="m.pm.settings['email']" name="jira-email" type="email" /></label>
        <label>Issue type <input [(ngModel)]="m.pm.settings['issueType']" name="jira-type" placeholder="Task" /></label>
        <details>
          <summary>Status names (if yours differ)</summary>
          <label>To do <input [(ngModel)]="m.pm.settings['statusTodo']" name="jira-s1" placeholder="To Do" /></label>
          <label>In progress <input [(ngModel)]="m.pm.settings['statusInProgress']" name="jira-s2" placeholder="In Progress" /></label>
          <label>In review <input [(ngModel)]="m.pm.settings['statusInReview']" name="jira-s3" placeholder="In Review" /></label>
          <label>Done <input [(ngModel)]="m.pm.settings['statusDone']" name="jira-s4" placeholder="Done" /></label>
        </details>
        <p class="hint">Add the Jira API token in Settings.</p>
      }
      @if (m.pm.provider === 'trello') {
        <label>Board id <input [(ngModel)]="m.pm.settings['boardId']" name="tr-board" /></label>
        <label>"To do" list id <input [(ngModel)]="m.pm.settings['listTodo']" name="tr-l1" /></label>
        <label>"In progress" list id <input [(ngModel)]="m.pm.settings['listInProgress']" name="tr-l2" /></label>
        <label>"In review" list id <input [(ngModel)]="m.pm.settings['listInReview']" name="tr-l3" /></label>
        <label>"Done" list id <input [(ngModel)]="m.pm.settings['listDone']" name="tr-l4" /></label>
        <p class="hint">Add the Trello API key and token in Settings.</p>
      }
    </fieldset>

    <fieldset>
      <legend>Design</legend>
      <label>Design tool
        <select [(ngModel)]="m.design.provider" name="design-provider">
          <option value="none">None</option>
          <option value="figma">Figma</option>
        </select>
      </label>
      @if (m.design.provider === 'figma') {
        <label>File key or URL <input [(ngModel)]="m.design.settings['file']" name="figma-file" /></label>
        <p class="hint">Tickets that link a Figma frame (a URL with node-id) give the worker that frame's names, text and a PNG. UI tickets (labels ui, frontend or area:ui) with no link get this file's pages and frames. Add the Figma token in Settings.</p>
      }
    </fieldset>
  `,
})
export class ConnectorFields {
  readonly model = input.required<ConnectorModel>();
}
