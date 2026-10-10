import { describe, expect, it } from 'vitest';
import { branchName, checkReady, commitMessage, DEFAULT_WORKFLOW_YAML, parseWorkflow, slugify, validateWorkflow } from '../src/workflow.js';
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
