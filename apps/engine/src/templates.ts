import { DEFAULT_WORKFLOW_YAML } from './workflow.js';

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  gates: { name: string; run: string }[];
  allowedCommands: string[];
  bestPractices: string;
  context: string;
}

/** The default workflow with the template's gates and allowed commands in place of the defaults. */
export function workflowFor(t: Pick<ProjectTemplate, 'gates' | 'allowedCommands'>): string {
  const gates = t.gates.map((g) => `  - name: ${g.name}\n    run: ${JSON.stringify(g.run)}`).join('\n');
  const allowed = t.allowedCommands.map((c) => `  - ${c}`).join('\n');
  return DEFAULT_WORKFLOW_YAML
    .replace(/quality_gates:([^\n]*)\n(?:  [^\n]*\n)+/, `quality_gates:$1\n${gates}\n`)
    .replace(/allowed_commands:([^\n]*)\n(?:  [^\n]*\n)+/, `allowed_commands:$1\n${allowed}\n`);
}

export const TEMPLATES: ProjectTemplate[] = [
  {
    id: 'node-api',
    name: 'Node.js API (TypeScript)',
    description: 'An HTTP API in TypeScript on Node, tested with Vitest or Jest.',
    gates: [
      { name: 'install', run: 'npm ci' },
      { name: 'lint', run: 'npm run lint --if-present' },
      { name: 'typecheck', run: 'npx tsc --noEmit' },
      { name: 'test', run: 'npm test' },
      { name: 'build', run: 'npm run build --if-present' },
    ],
    allowedCommands: ['npm run', 'npx tsc', 'npx vitest', 'npx jest'],
    context: 'A Node.js HTTP API written in TypeScript.',
    bestPractices: `- TypeScript strict mode; no \`any\` unless commented why.
- Validate every request at the edge (e.g. zod) and return clear 4xx errors; never trust input.
- Keep handlers thin: routing, validation, then a function in a service module.
- Every endpoint and bug fix gets a test; test through the HTTP layer where it matters.
- No secrets in code or logs; read configuration from the environment.
- Use async/await, handle errors once at the top, and never swallow them silently.
- Small modules with one job; name things for what they do.`,
  },
  {
    id: 'angular',
    name: 'Angular app',
    description: 'A standalone-component Angular app with signals.',
    gates: [
      { name: 'install', run: 'npm ci' },
      { name: 'lint', run: 'npm run lint --if-present' },
      { name: 'test', run: 'npx ng test --watch=false' },
      { name: 'build', run: 'npx ng build' },
    ],
    allowedCommands: ['npm run', 'npx ng'],
    context: 'An Angular single-page app.',
    bestPractices: `- Standalone components, signals for state, and the built-in control flow (@if, @for).
- Keep components small and presentational; put HTTP and state in injectable services.
- Typed forms; no \`any\` in templates or services.
- Accessible markup: labels for inputs, buttons for actions, keyboard reachable, sufficient contrast.
- No direct DOM access; use bindings, and DestroyRef or takeUntilDestroyed for cleanup.
- Every component and service change comes with a TestBed or unit test.
- Follow the existing styles and design tokens; don't add new global CSS without need.`,
  },
  {
    id: 'python',
    name: 'Python project',
    description: 'A Python package or service, tested with pytest and linted with ruff.',
    gates: [
      { name: 'install', run: 'python -m pip install -q -r requirements.txt' },
      { name: 'lint', run: 'python -m ruff check .' },
      { name: 'test', run: 'python -m pytest -q' },
    ],
    allowedCommands: ['python -m pytest', 'python -m ruff', 'python -m pip'],
    context: 'A Python project.',
    bestPractices: `- Type hints on public functions; keep functions short and pure where possible.
- Tests with pytest for every change, including the failure case.
- Format and lint with ruff; follow PEP 8 naming.
- No mutable global state; pass dependencies in.
- Raise specific exceptions with clear messages; never use a bare except.
- Pin dependencies in requirements.txt (or pyproject.toml) and add new ones there.`,
  },
];

export function templateById(id: string | undefined): ProjectTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
