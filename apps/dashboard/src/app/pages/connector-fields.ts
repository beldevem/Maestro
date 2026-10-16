import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../api';
import type { Project } from '../models';
import { FolderPicker, type PickedFolder } from '../ui/folder-picker';

export type ConnectorModel = Pick<Project, 'codeHost' | 'pm' | 'design' | 'docs'>;

export function emptyConnectors(): ConnectorModel {
  return {
    codeHost: { provider: 'github', repo: '', localPath: '', defaultBranch: 'main' },
    pm: { provider: 'manual', settings: {} },
    design: { provider: 'none', settings: {} },
    docs: { provider: 'none', settings: {} },
  };
}

/** Code host, PM tool, design tool and docs choices for a project. Edits the model in place. */
@Component({
  selector: 'app-connector-fields',
  imports: [FormsModule, FolderPicker],
  template: `
    @let m = model();
    @if (show('codeHost')) {
    <fieldset>
      <legend>Code host</legend>
      <label>Provider
        <select [(ngModel)]="m.codeHost.provider" name="ch-provider">
          <option value="github">GitHub</option>
          <option value="local">Local folder on this machine</option>
          <option value="gitlab">GitLab</option>
          <option value="bitbucket">Bitbucket Cloud</option>
        </select>
      </label>
      @if (m.codeHost.provider === 'github') {
        <label>Repository <input [(ngModel)]="m.codeHost.repo" name="ch-repo" placeholder="owner/name" required /></label>
        <p class="hint">Add a GitHub token in Settings.</p>
      } @else if (m.codeHost.provider === 'gitlab') {
        <div class="row">
          <label>Project path <input [(ngModel)]="m.codeHost.repo" name="ch-repo" placeholder="group/project" required /></label>
          <label>GitLab URL <input [(ngModel)]="m.codeHost.baseUrl" name="ch-base" placeholder="https://gitlab.com" /></label>
        </div>
        <p class="hint">Add a GitLab token (api and write_repository scopes) in Settings. Merge requests are opened and reviewed like pull requests.</p>
      } @else if (m.codeHost.provider === 'bitbucket') {
        <label>Repository <input [(ngModel)]="m.codeHost.repo" name="ch-repo" placeholder="workspace/repo" required /></label>
        <p class="hint">Add your Bitbucket username and an app password (Repositories and Pull requests, read and write) in Settings.</p>
      } @else {
        <div class="path-row">
          <label>Folder path <input [(ngModel)]="m.codeHost.localPath" name="ch-path" placeholder="/home/you/projects/app" required spellcheck="false"
            (blur)="check(m.codeHost.localPath)" [attr.aria-describedby]="folderNote() ? 'ch-path-note' : null" /></label>
          <button type="button" (click)="browsing.set(true)" aria-haspopup="dialog">Browse…</button>
        </div>
        @if (folderNote(); as n) { <p id="ch-path-note" [class]="n.kind" role="status">{{ n.text }}</p> }
        @if (browsing()) {
          <app-folder-picker [start]="m.codeHost.localPath ?? ''" (chosen)="picked(m, $event)" (cancel)="browsing.set(false)" />
        }
      }
      <label>Default branch <input [(ngModel)]="m.codeHost.defaultBranch" name="ch-branch" /></label>
    </fieldset>
    }

    @if (show('pm')) {
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
    }

    @if (show('design')) {
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
    }

    @if (show('docs')) {
    <fieldset>
      <legend>Docs</legend>
      <label>Docs tool
        <select [(ngModel)]="m.docs.provider" name="docs-provider">
          <option value="none">None</option>
          <option value="confluence">Confluence</option>
        </select>
      </label>
      @if (m.docs.provider === 'confluence') {
        <label>Pages <textarea [(ngModel)]="m.docs.settings['pages']" name="docs-pages" rows="3" placeholder="One page URL or id per line"></textarea></label>
        @if (m.pm.provider !== 'jira') {
          <div class="row">
            <label>Site URL <input [(ngModel)]="m.docs.settings['baseUrl']" name="docs-url" placeholder="https://your-team.atlassian.net" /></label>
            <label>Account email <input [(ngModel)]="m.docs.settings['email']" name="docs-email" type="email" /></label>
          </div>
        }
        <p class="hint">The planner and workers read these pages, plus any Confluence page linked in the requirements or a ticket. Uses {{ m.pm.provider === 'jira' ? 'the Jira site and email above' : 'this site and email' }} with the Atlassian API token from Settings.</p>
      }
    </fieldset>
    }
  `,
})
export class ConnectorFields {
  readonly model = input.required<ConnectorModel>();
  /** Show one section only (for the new-project steps); all of them when empty. */
  readonly only = input<'' | 'codeHost' | 'pm' | 'design' | 'docs'>('');

  private readonly api = inject(Api);
  readonly browsing = signal(false);
  /** What the engine found at the folder path: not a git repository, or out of its sight. */
  readonly folderNote = signal<{ kind: 'warn' | 'error'; text: string } | null>(null);

  picked(m: ConnectorModel, f: PickedFolder): void {
    m.codeHost.localPath = f.path;
    if (f.branch) m.codeHost.defaultBranch = f.branch;
    this.browsing.set(false);
    this.note(f);
  }

  /** Checks a typed path, so a wrong one shows before the project is saved. */
  async check(path: string | undefined): Promise<void> {
    if (!path?.trim()) return this.folderNote.set(null);
    try {
      this.note(await this.api.fsCheck(path.trim()));
    } catch (e) {
      this.folderNote.set({ kind: 'error', text: (e as Error).message });
    }
  }

  private note(f: PickedFolder): void {
    this.folderNote.set(f.isGitRepo ? null : { kind: 'warn', text: `${f.path} isn't a git repository yet. Run "git init" there and make a first commit before assigning tickets.` });
  }

  show(section: 'codeHost' | 'pm' | 'design' | 'docs'): boolean {
    return !this.only() || this.only() === section;
  }
}
