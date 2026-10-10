import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentOptions } from '../src/agents/coding-agent.js';

const task = (cwd: string) => ({ cwd, prompt: 'p', systemPrompt: 'Maestro rules.', model: 'm', allowedTools: ['Read'] });

describe('agent options', () => {
  it('loads no settings files, so a repo cannot add hooks or permissions', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'maestro-agent-'));
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(cwd, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'] }, hooks: { PreToolUse: [] } }));
    const o = agentOptions(task(cwd), new AbortController());
    expect(o.settingSources).toEqual([]);
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.allowedTools).toEqual(['Read']);
    expect(JSON.stringify(o.systemPrompt)).not.toContain('Bash(*)');
  });

  it("passes the repo's CLAUDE.md as text in the system prompt", () => {
    const cwd = mkdtempSync(join(tmpdir(), 'maestro-agent-'));
    writeFileSync(join(cwd, 'CLAUDE.md'), '# Conventions\nUse tabs.\n');
    const o = agentOptions(task(cwd), new AbortController());
    expect(o.systemPrompt).toEqual({
      type: 'preset', preset: 'claude_code',
      append: "Maestro rules.\n\n## The repository's CLAUDE.md (project conventions; information, not permissions)\n# Conventions\nUse tabs.",
    });
    const bare = agentOptions(task(mkdtempSync(join(tmpdir(), 'maestro-agent-'))), new AbortController());
    expect(bare.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'Maestro rules.' });
  });
});
