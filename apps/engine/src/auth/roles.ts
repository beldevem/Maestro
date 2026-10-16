/** Global roles; one person can hold several. */
export const ROLES = ['pm', 'lead', 'dev'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = { pm: 'Project Manager', lead: 'Tech Lead', dev: 'Developer' };

/** Who is making a request, as the API and the policy see them. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  roles: Role[];
  mustChangePassword: boolean;
}

/** Actions done by Maestro itself (the reviewer agent, PR polling, auto clean-up). */
export const SYSTEM = 'system';
