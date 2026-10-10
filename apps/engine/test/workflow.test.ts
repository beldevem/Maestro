import { describe, expect, it } from 'vitest';
import { blockedBy, branchName, checkReady, commitMessage, DEFAULT_WORKFLOW_YAML, parseWorkflow, slugify, ticketArea, validateWorkflow } from '../src/workflow.js';
import { joinDescription, sizeFromLabels, splitDescription } from '../src/adapters/pm/types.js';
import type { Ticket } from '../src/types.js';

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  key: 'MAE-42', title: 'Add login form', description: '', acceptanceCriteria: 'User can log in', status: 'todo', labels: [], ...over,
});

describe('workflow config', () => {
  it('parses the default config', () => {
    const wf = parseWorkflow(DEFAULT_WORKFLOW_YAML);
    expect(wf.base_branch).toBe('main');
    expect(wf.quality_gates.map((g) => g.name)).toEqual(['install', 'lint', 'test', 'build']);
    expect(wf.max_fix_attempts).toBe(3);
  });

  it('has orchestration defaults, also for configs written before the section existed', () => {
    expect(parseWorkflow(DEFAULT_WORKFLOW_YAML).orchestration).toEqual({ auto_assign: false, dependency_ready_when: 'done', max_parallel: 2, one_per_area: true });
    expect(parseWorkflow('base_branch: main\n').orchestration.max_parallel).toBe(2);
    expect(parseWorkflow('orchestration:\n  auto_assign: true\n').orchestration).toMatchObject({ auto_assign: true, one_per_area: true });
    expect(validateWorkflow('orchestration:\n  dependency_ready_when: soon\n').ok).toBe(false);
  });

  it('reports invalid config', () => {
    expect(validateWorkflow('max_fix_attempts: lots').ok).toBe(false);
  });

  it('builds branch names and commit messages from the ticket', () => {
    const wf = parseWorkflow(DEFAULT_WORKFLOW_YAML);
    expect(branchName(wf.branch_pattern, ticket())).toBe('feat/MAE-42-add-login-form');
    expect(branchName(wf.branch_pattern, ticket({ labels: ['bug'], title: 'Crash on émoji input!' }))).toBe('fix/MAE-42-crash-on-emoji-input');
    expect(commitMessage(wf, ticket())).toBe('feat: add login form [MAE-42]');
  });

  it('slugifies within the length limit', () => {
    expect(slugify('A'.repeat(60) + ' tail', 10)).toBe('aaaaaaaaaa');
  });
});

describe('definition of ready', () => {
  const wf = parseWorkflow(DEFAULT_WORKFLOW_YAML);
  it('accepts a ticket with acceptance criteria and a small size', () => {
    expect(checkReady(wf, ticket({ size: 'S' }))).toEqual([]);
  });
  it('rejects missing acceptance criteria and oversized tickets', () => {
    const reasons = checkReady(wf, ticket({ acceptanceCriteria: ' ', size: 'XL' }));
    expect(reasons).toHaveLength(2);
  });
});

describe('PM text helpers', () => {
  it('round-trips acceptance criteria through a description', () => {
    const text = joinDescription('Build it.', '- works');
    expect(splitDescription(text)).toEqual({ description: 'Build it.', acceptanceCriteria: '- works' });
  });
  it('reads sizes from labels', () => {
    expect(sizeFromLabels(['frontend', 'size:m'])).toBe('M');
    expect(sizeFromLabels(['frontend'])).toBeUndefined();
  });
});

describe('dependencies and areas', () => {
  const tickets = [
    { key: 'A', status: 'in_review' as const },
    { key: 'B', status: 'todo' as const },
    { key: 'C', status: 'todo' as const },
  ];
  const deps = new Map([['B', ['A']], ['C', ['A', 'B', 'GONE']]]);
  it('blocks on deps that are not done', () => {
    const blocked = blockedBy(tickets, deps, 'done');
    expect(blocked.get('A')).toEqual([]);
    expect(blocked.get('B')).toEqual(['A']);
    expect(blocked.get('C')).toEqual(['A', 'B']);
  });
  it('can count in-review deps as satisfied', () => {
    expect(blockedBy(tickets, deps, 'in_review').get('B')).toEqual([]);
  });
  it('reads the area label', () => {
    expect(ticketArea({ labels: ['bug', 'area:API'] })).toBe('api');
    expect(ticketArea({ labels: ['bug'] })).toBeNull();
  });
});
