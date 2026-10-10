import { describe, expect, it } from 'vitest';
import { GitHubCodeHost } from '../src/adapters/codehost/github.js';
import { MAESTRO_MARK } from '../src/adapters/codehost/types.js';
import type { Project } from '../src/types.js';
import { fakeApi } from './fake-api.js';

const project: Project = {
  id: 'p', name: 'X', description: '', codeHost: { provider: 'github', repo: 'me/app', defaultBranch: 'main' },
  pm: { provider: 'manual', settings: {} }, design: { provider: 'none', settings: {} }, docs: { provider: 'none', settings: {} },
  context: '', requirements: '', bestPractices: '', workflowYaml: '', createdAt: '',
};
const review = {
  verdict: 'changes_requested' as const, summary: 'Two things.', commitSha: 'sha1',
  comments: [{ file: 'src/a.ts', line: 4, body: 'Handle null.' }, { file: null, line: null, body: 'Update the README.' }],
};

describe('GitHub', () => {
  it('opens a draft pull request', async () => {
    const api = fakeApi({ 'POST /repos/me/app/pulls': [201, { html_url: 'https://github.com/me/app/pull/3', number: 3 }] });
    const pr = await new GitHubCodeHost(() => 'ghp', '/tmp', api.impl).openPullRequest(project, { branch: 'feat/x', base: 'main', title: 'T', body: 'B', draft: true });
    expect(pr).toEqual({ url: 'https://github.com/me/app/pull/3', number: 3 });
    expect(api.calls[0].headers.Authorization).toBe('Bearer ghp');
    expect(api.calls[0].body).toEqual({ title: 'T', head: 'feat/x', base: 'main', body: 'B', draft: true });
  });

  it('posts a review with inline comments as asked when GitHub accepts it', async () => {
    const api = fakeApi({ 'POST /pulls/3/reviews': [200, { id: 55 }] });
    const posted = await new GitHubCodeHost(() => 'ghp', '/tmp', api.impl).postReview(project, 3, review);
    expect(posted).toEqual({ externalIds: ['review:55'], note: undefined });
    const body = api.calls[0].body;
    expect(body.event).toBe('REQUEST_CHANGES');
    expect(body.commit_id).toBe('sha1');
    expect(body.comments).toEqual([{ path: 'src/a.ts', line: 4, side: 'RIGHT', body: `Handle null.\n\n${MAESTRO_MARK}` }]);
    expect(body.body).toContain('- Update the README.');
    expect(body.body).toContain(MAESTRO_MARK);
  });

  it('falls back to a comment on your own PR, then to one comment when lines are refused', async () => {
    const api = fakeApi({
      'POST /pulls/3/reviews': (c) =>
        c.body.event !== 'COMMENT' ? [422, { message: 'Can not request changes on your own pull request' }]
        : c.body.comments.length ? [422, { message: 'Line could not be resolved' }]
        : [200, { id: 56 }],
    });
    const posted = await new GitHubCodeHost(() => 'ghp', '/tmp', api.impl).postReview(project, 3, review);
    expect(api.calls.map((c) => [c.body.event, c.body.comments.length])).toEqual([['REQUEST_CHANGES', 1], ['COMMENT', 1], ['COMMENT', 0]]);
    expect(api.calls[2].body.body).toContain('`src/a.ts:4`: Handle null.');
    expect(posted).toEqual({ externalIds: ['review:56'], note: 'Posted as one comment: GitHub did not accept the inline comments.' });
  });

  it('does not retry other errors', async () => {
    const api = fakeApi({ 'POST /pulls/3/reviews': [401, { message: 'Bad credentials' }] });
    await expect(new GitHubCodeHost(() => 'ghp', '/tmp', api.impl).postReview(project, 3, review)).rejects.toThrow(/401/);
    expect(api.calls).toHaveLength(1);
  });

  it('reads state, checks and feedback, skipping its own posts and plain chatter', async () => {
    const api = fakeApi({
      'GET /repos/me/app/pulls/3': [200, { state: 'open', merged: false, head: { sha: 'h1' } }],
      'GET /repos/me/app/pulls/3/reviews': [200, [
        { id: 1, state: 'COMMENTED', body: `bot ${MAESTRO_MARK}`, user: { login: 'me' }, submitted_at: '2026-10-10T10:00:00Z' },
        { id: 2, state: 'CHANGES_REQUESTED', body: 'Please split this.', user: { login: 'bel' }, submitted_at: '2026-10-10T11:00:00Z' },
        { id: 3, state: 'COMMENTED', body: '', user: { login: 'bel' }, submitted_at: '2026-10-10T11:00:01Z' },
      ]],
      'GET /repos/me/app/pulls/3/comments': [200, [{ id: 9, path: 'src/a.ts', line: 12, body: 'Typo here', user: { login: 'bel' }, created_at: '2026-10-10T11:00:02Z' }]],
      'GET /repos/me/app/issues/3/comments': [200, [
        { id: 20, body: 'Thanks!', user: { login: 'bel' }, created_at: '2026-10-10T12:00:00Z' },
        { id: 21, body: '@maestro also add a test', user: { login: 'bel' }, created_at: '2026-10-10T12:01:00Z' },
      ]],
      'GET /repos/me/app/commits/h1/check-runs': [200, { check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }] }],
      'GET /repos/me/app/commits/h1/status': [200, { state: 'pending', statuses: [] }],
    });
    const s = await new GitHubCodeHost(() => 'ghp', '/tmp', api.impl).pullRequestStatus(project, 3);
    expect(s.state).toBe('open');
    expect(s.checks).toBe('failure');
    expect(s.feedback.map((f) => [f.externalId, f.verdict, f.file, f.line])).toEqual([
      ['review:2', 'changes_requested', null, null],
      ['comment:9', 'changes_requested', 'src/a.ts', 12],
      ['issue-comment:21', 'changes_requested', null, null],
    ]);
  });

  it('reports merged and closed pull requests', async () => {
    const status = (pr: object) => fakeApi({
      'GET /repos/me/app/pulls/3': [200, { ...pr, head: { sha: 'h' } }],
      'GET /repos/me/app/pulls/3/reviews': [200, []], 'GET /repos/me/app/pulls/3/comments': [200, []], 'GET /repos/me/app/issues/3/comments': [200, []],
      'GET /repos/me/app/commits/h/check-runs': [200, { check_runs: [] }], 'GET /repos/me/app/commits/h/status': [200, { state: 'pending', statuses: [] }],
    }).impl;
    expect((await new GitHubCodeHost(() => 'ghp', '/tmp', status({ state: 'closed', merged: true })).pullRequestStatus(project, 3)).state).toBe('merged');
    expect((await new GitHubCodeHost(() => 'ghp', '/tmp', status({ state: 'closed', merged: false })).pullRequestStatus(project, 3)).state).toBe('closed');
  });
});
