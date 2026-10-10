import { describe, expect, it } from 'vitest';
import { adfToText, JiraPm, textToAdf } from '../src/adapters/pm/jira.js';
import { TrelloPm } from '../src/adapters/pm/trello.js';
import { fakeApi, type Call } from './fake-api.js';

const trelloSettings = { boardId: 'B1', listTodo: 'L-todo', listInProgress: 'L-doing', listInReview: 'L-review', listDone: 'L-done' };
const creds = () => ({ key: 'k', token: 't' });
const params = (c: Call) => new URL(c.url).searchParams;

describe('Trello', () => {
  it('creates a card with its labels and size, creating labels the board lacks', async () => {
    const api = fakeApi({
      'GET /boards/B1/labels': [200, [{ id: 'lab-ui', name: 'area:ui' }]],
      'POST /labels': (c) => [200, { id: `lab-${params(c).get('name')}` }],
      'POST /cards': (c) => [200, {
        id: 'c1', shortLink: 'abc123', shortUrl: 'https://trello.com/c/abc123', name: params(c).get('name'), desc: params(c).get('desc'),
        idList: params(c).get('idList'), labels: (params(c).get('idLabels') ?? '').split(',').map((id) => ({ id, name: id === 'lab-ui' ? 'area:ui' : id.slice(4) })),
      }],
    });
    const pm = new TrelloPm(trelloSettings, creds, api.impl);
    const t = await pm.createTicket({ title: 'Login page', description: 'Build it.', acceptanceCriteria: '- works', size: 'S', labels: ['area:UI', 'frontend'] });

    const create = api.calls.find((c) => c.url.includes('/cards'))!;
    expect(params(create).get('idList')).toBe('L-todo');
    expect(params(create).get('idLabels')).toBe('lab-ui,lab-frontend,lab-size:S');
    expect(api.calls.filter((c) => c.method === 'POST' && c.url.includes('/labels')).map((c) => params(c).get('name'))).toEqual(['frontend', 'size:S']);
    expect(t).toMatchObject({ key: 'abc123', title: 'Login page', description: 'Build it.', acceptanceCriteria: '- works', status: 'todo', size: 'S' });
    expect(t.labels).toContain('area:ui');
  });

  it('lists cards with status from their list and moves them', async () => {
    const api = fakeApi({
      'GET /boards/B1/cards/open': [200, [
        { id: '1', shortLink: 'a', name: 'A', desc: '', idList: 'L-review', labels: [{ name: 'size:M' }] },
        { id: '2', shortLink: 'b', name: 'B', desc: 'x\n\nAcceptance criteria:\n- y', idList: 'L-other', labels: [] },
      ]],
      'PUT /cards/a': [200, {}],
    });
    const pm = new TrelloPm(trelloSettings, creds, api.impl);
    const tickets = await pm.listTickets();
    expect(tickets.map((t) => [t.key, t.status, t.size ?? null, t.acceptanceCriteria])).toEqual([['a', 'in_review', 'M', ''], ['b', 'todo', null, '- y']]);
    await pm.moveTicket('a', 'done');
    expect(params(api.calls.at(-1)!).get('idList')).toBe('L-done');
  });

  it('asks for credentials and list settings', async () => {
    await expect(new TrelloPm(trelloSettings, () => ({}), fakeApi({}).impl).listTickets()).rejects.toThrow(/API key and token/);
    await expect(new TrelloPm({ ...trelloSettings, listTodo: '' }, creds, fakeApi({}).impl).createTicket({ title: 'x', description: '', acceptanceCriteria: '', labels: [] })).rejects.toThrow(/Trello list for "todo"/);
  });
});

describe('Jira', () => {
  const settings = { baseUrl: 'https://team.atlassian.net/', projectKey: 'APP', email: 'me@x.io', statusInReview: 'Code Review' };
  const issue = (key: string, status: string, category: string, description: unknown, labels: string[] = []) => ({
    key, fields: { summary: `Title ${key}`, description, status: { name: status, statusCategory: { key: category } }, labels },
  });

  it('creates an issue with the acceptance criteria and size, and reads it back the same', async () => {
    let stored: any;
    const api = fakeApi({
      'POST /rest/api/3/issue': (c) => {
        stored = c.body.fields;
        return [201, { key: 'APP-7' }];
      },
      'GET /rest/api/3/issue/APP-7': () => [200, issue('APP-7', 'To Do', 'new', stored.description, stored.labels)],
    });
    const pm = new JiraPm(settings, () => 'tok', api.impl);
    const t = await pm.createTicket({ title: 'Title APP-7', description: 'Build the form.', acceptanceCriteria: '- Has a name field\n- Validates', size: 'M', labels: ['area:ui', 'needs design'] });
    expect(api.calls[0].headers.Authorization).toBe(`Basic ${Buffer.from('me@x.io:tok').toString('base64')}`);
    expect(stored.labels).toEqual(['area:ui', 'needs-design', 'size:M']);
    expect(stored.issuetype).toEqual({ name: 'Task' });
    expect(t).toMatchObject({ key: 'APP-7', description: 'Build the form.', acceptanceCriteria: '- Has a name field\n- Validates', size: 'M', status: 'todo', url: 'https://team.atlassian.net/browse/APP-7' });
  });

  it('maps statuses by configured names, then by category', async () => {
    const api = fakeApi({
      'GET /rest/api/3/search/jql': [200, { issues: [
        issue('APP-1', 'Code Review', 'indeterminate', null),
        issue('APP-2', 'Doing', 'indeterminate', null),
        issue('APP-3', 'Shipped', 'done', null),
        issue('APP-4', 'Backlog', 'new', null),
      ] }],
    });
    const tickets = await new JiraPm(settings, () => 'tok', api.impl).listTickets();
    expect(tickets.map((t) => t.status)).toEqual(['in_review', 'in_progress', 'done', 'todo']);
    expect(decodeURIComponent(api.calls[0].url)).toContain('project = "APP" ORDER BY rank ASC');
  });

  it('moves an issue through the matching transition, and leaves it when there is none', async () => {
    const api = fakeApi({
      'GET /transitions': [200, { transitions: [{ id: '11', name: 'Start', to: { name: 'In Progress' } }, { id: '21', name: 'Send to review', to: { name: 'Code Review' } }] }],
      'POST /transitions': [204, null],
    });
    const pm = new JiraPm(settings, () => 'tok', api.impl);
    await pm.moveTicket('APP-1', 'in_review');
    expect(api.calls.at(-1)!.body).toEqual({ transition: { id: '21' } });
    const before = api.calls.length;
    await pm.moveTicket('APP-1', 'done');
    expect(api.calls.length).toBe(before + 1);
  });
});

describe('Jira document format', () => {
  it('round-trips plain text line by line', () => {
    const text = 'First line\n\nAcceptance criteria:\n- one\n- two';
    expect(adfToText(textToAdf(text)).trimEnd()).toBe(text);
  });
  it('keeps list markers, line breaks and code from text written in Jira', () => {
    const doc = {
      type: 'doc', content: [
        { type: 'heading', content: [{ type: 'text', text: 'Acceptance criteria' }] },
        { type: 'bulletList', content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Shows a form' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Saves' }, { type: 'hardBreak' }, { type: 'text', text: 'on submit' }] }] },
        ] },
        { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First' }] }] }] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'npm test' }] },
      ],
    };
    expect(adfToText(doc)).toBe('Acceptance criteria\n- Shows a form\n- Saves\n  on submit\n1. First\n```\nnpm test\n```\n');
  });
});
