import { describe, expect, it } from 'vitest';
import { BitbucketCodeHost } from '../src/adapters/codehost/bitbucket.js';
import { GitLabCodeHost } from '../src/adapters/codehost/gitlab.js';
import { HttpGit } from '../src/adapters/codehost/http-git.js';
import { MAESTRO_MARK } from '../src/adapters/codehost/types.js';
import type { Project } from '../src/types.js';
import { fakeApi } from './fake-api.js';

const project = (provider: Project['codeHost']['provider'], repo: string, baseUrl?: string): Project => ({
  id: 'p1', name: 'X', description: '', codeHost: { provider, repo, baseUrl, defaultBranch: 'main' },
  pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} }, docs: { provider: 'none', settings: {} },
  context: '', requirements: '', bestPractices: '', workflowYaml: '', createdAt: '',
});

const review = {
  verdict: 'approve' as const, summary: 'Fine overall.', commitSha: 'abc',
  comments: [{ file: 'src/a.ts', line: 3, body: 'Rename this.' }, { file: null, line: null, body: 'Add a changelog entry.' }],
};

describe('HttpGit', () => {
  it('sends credentials in a per-command header only', () => {
    const args = new HttpGit('https://gitlab.com/', () => ({ user: 'oauth2', secret: 'tok' })).authArgs();
    expect(args).toEqual(['-c', `http.https://gitlab.com/.extraheader=AUTHORIZATION: basic ${Buffer.from('oauth2:tok').toString('base64')}`]);
    expect(new HttpGit('https://x', () => undefined).authArgs()).toEqual([]);
  });
});

describe('GitLab', () => {
  const p = project('gitlab', 'team/app', 'https://gitlab.example.com/');
  const enc = encodeURIComponent('team/app');

  it('opens a draft merge request with the token header', async () => {
    const api = fakeApi({ 'POST /merge_requests': [201, { web_url: 'https://gitlab.example.com/team/app/-/merge_requests/4', iid: 4 }] });
    const host = new GitLabCodeHost(() => 'glpat', '/tmp', api.impl);
    const mr = await host.openPullRequest(p, { branch: 'feat/x', base: 'main', title: 'X-1: Do it', body: 'Body', draft: true });
    expect(mr).toEqual({ url: 'https://gitlab.example.com/team/app/-/merge_requests/4', number: 4 });
    expect(api.calls[0].url).toBe(`https://gitlab.example.com/api/v4/projects/${enc}/merge_requests`);
    expect(api.calls[0].headers['PRIVATE-TOKEN']).toBe('glpat');
    expect(api.calls[0].body).toMatchObject({ source_branch: 'feat/x', target_branch: 'main', title: 'Draft: X-1: Do it' });
  });

  it('posts line comments as diff discussions and the rest as a note, and tries to approve', async () => {
    const api = fakeApi({
      'GET /versions': [200, [{ base_commit_sha: 'b', start_commit_sha: 's', head_commit_sha: 'h' }]],
      'POST /discussions': [201, { id: 'd1' }],
      'POST /notes': [201, { id: 9 }],
      'POST /approve': [401, { message: 'cannot approve own' }],
    });
    const posted = await new GitLabCodeHost(() => 'glpat', '/tmp', api.impl).postReview(p, 4, review);
    const discussion = api.calls.find((c) => c.url.endsWith('/discussions'))!;
    expect(discussion.body.position).toEqual({ position_type: 'text', base_sha: 'b', start_sha: 's', head_sha: 'h', new_path: 'src/a.ts', new_line: 3 });
    const note = api.calls.find((c) => c.url.endsWith('/notes'))!;
    expect(note.body.body).toContain('Add a changelog entry.');
    expect(note.body.body).toContain(MAESTRO_MARK);
    expect(note.body.body).not.toContain('Rename this.');
    expect(posted.externalIds).toEqual(['discussion:d1', 'note:9']);
    expect(posted.note).toMatch(/did not accept the approval/);
  });

  it('reads merge request state, pipeline and feedback that is not ours', async () => {
    const api = fakeApi({
      'GET /merge_requests/4': [200, { state: 'opened', sha: 'h1', head_pipeline: { status: 'failed' } }],
      'GET /merge_requests/4/notes': [200, [
        { id: 1, system: true, body: 'added 1 commit' },
        { id: 2, body: `Ours ${MAESTRO_MARK}`, author: { username: 'me' }, created_at: '1' },
        { id: 3, type: 'DiffNote', body: 'Off by one', position: { new_path: 'src/a.ts', new_line: 7 }, author: { username: 'bel' }, created_at: '2' },
        { id: 4, body: 'Looks fine', author: { username: 'bel' }, created_at: '3' },
        { id: 5, body: '@maestro please add tests', author: { username: 'bel' }, created_at: '4' },
      ]],
    });
    const s = await new GitLabCodeHost(() => 'glpat', '/tmp', api.impl).pullRequestStatus(p, 4);
    expect(s.state).toBe('open');
    expect(s.checks).toBe('failure');
    expect(s.feedback.map((f) => [f.externalId, f.file, f.line])).toEqual([['note:3', 'src/a.ts', 7], ['note:5', null, null]]);
  });
});

describe('Bitbucket', () => {
  const p = project('bitbucket', 'ws/app');
  const creds = () => ({ user: 'bel', secret: 'app-pass' });

  it('opens a pull request with basic auth', async () => {
    const api = fakeApi({ 'POST /pullrequests': [201, { id: 12, links: { html: { href: 'https://bitbucket.org/ws/app/pull-requests/12' } } }] });
    const pr = await new BitbucketCodeHost(creds, '/tmp', api.impl).openPullRequest(p, { branch: 'feat/x', base: 'main', title: 'T', body: 'B', draft: false });
    expect(pr).toEqual({ url: 'https://bitbucket.org/ws/app/pull-requests/12', number: 12 });
    expect(api.calls[0].url).toBe('https://api.bitbucket.org/2.0/repositories/ws/app/pullrequests');
    expect(api.calls[0].headers.Authorization).toBe(`Basic ${Buffer.from('bel:app-pass').toString('base64')}`);
    expect(api.calls[0].body).toMatchObject({ source: { branch: { name: 'feat/x' } }, destination: { branch: { name: 'main' } } });
  });

  it('posts inline comments, a summary, and requests changes when allowed', async () => {
    const api = fakeApi({ 'POST /comments': [201, { id: 5 }], 'POST /request-changes': [200, {}] });
    const posted = await new BitbucketCodeHost(creds, '/tmp', api.impl).postReview(p, 12, { ...review, verdict: 'changes_requested' });
    const comments = api.calls.filter((c) => c.url.endsWith('/comments'));
    expect(comments[0].body.inline).toEqual({ path: 'src/a.ts', to: 3 });
    expect(comments[1].body.content.raw).toContain('**Changes requested**');
    expect(api.calls.some((c) => c.url.endsWith('/request-changes'))).toBe(true);
    expect(posted.note).toBeUndefined();
  });

  it('maps state, build statuses and comments', async () => {
    const api = fakeApi({
      'GET /pullrequests/12': [200, { state: 'MERGED', source: { commit: { hash: 'c1' } } }],
      'GET /pullrequests/12/statuses': [200, { values: [{ state: 'SUCCESSFUL' }, { state: 'INPROGRESS' }] }],
      'GET /pullrequests/12/comments': [200, { values: [
        { id: 1, content: { raw: 'Use const' }, inline: { path: 'a.ts', to: 2 }, user: { display_name: 'Bel' }, created_on: '2' },
        { id: 2, content: { raw: 'nice' }, user: { display_name: 'Bel' }, created_on: '1' },
        { id: 3, deleted: true, content: { raw: '@maestro x' }, created_on: '3' },
      ] }],
    });
    const s = await new BitbucketCodeHost(creds, '/tmp', api.impl).pullRequestStatus(p, 12);
    expect(s).toMatchObject({ state: 'merged', checks: 'pending', headSha: 'c1' });
    expect(s.feedback).toHaveLength(1);
    expect(s.feedback[0]).toMatchObject({ author: 'Bel', file: 'a.ts', line: 2, verdict: 'changes_requested' });
  });

  it('asks for credentials', async () => {
    await expect(new BitbucketCodeHost(() => undefined, '/tmp').openPullRequest(p, { branch: 'b', base: 'main', title: 't', body: '', draft: true })).rejects.toThrow(/app password/);
  });
});
