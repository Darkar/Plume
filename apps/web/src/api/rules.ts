import { api } from './client';

export type TextField =
  'from' | 'to' | 'cc' | 'subject' | 'body_text' | 'attachment_name' | 'list_id';
export type TextOp =
  'contains' | 'not_contains' | 'equals' | 'starts_with' | 'ends_with' | 'matches';

export type Condition =
  | { field: TextField | `header:${string}`; op: TextOp; value: string }
  | { field: 'size'; op: 'greater_than' | 'less_than'; value: number }
  | { field: 'has_attachment'; op: 'is'; value: boolean };

export type Action =
  | { type: 'move'; folder: string }
  | { type: 'archive' }
  | { type: 'add_label'; label: string }
  | { type: 'remove_label'; label: string }
  | { type: 'mark_read' }
  | { type: 'star' }
  | { type: 'delete' }
  | { type: 'forward'; to: string }
  | { type: 'auto_reply'; subject: string; body: string };

export interface RuleDefinition {
  name: string;
  enabled: boolean;
  match: 'all' | 'any';
  conditions: Condition[];
  actions: Action[];
  stop_processing: boolean;
}

export interface StoredRule extends RuleDefinition {
  id: string;
  position: number;
  stats: {
    lastRunAt: string | null;
    processedCount: number;
    errorCount: number;
    lastError: string | null;
  };
}

export interface RulesResponse {
  rules: StoredRule[];
  limits: {
    enabled: boolean;
    maxRules: number;
    forward: { enabled: boolean; domains: string[] };
    allowedHeaders?: string[];
  };
}

export interface DryRun {
  tested: number;
  matches: { id: string; subject: string; from: { name: string; address: string }[] }[];
}

export const rulesKey = ['rules'] as const;
export const fetchRules = () => api<RulesResponse>('GET', '/rules');
export const createRule = (rule: RuleDefinition) => api<StoredRule>('POST', '/rules', rule);
export const updateRule = (id: string, patch: Partial<RuleDefinition>) =>
  api<StoredRule>('PATCH', `/rules/${id}`, patch);
export const deleteRule = (id: string) => api<void>('DELETE', `/rules/${id}`);
export const reorderRules = (ids: string[]) =>
  api<{ rules: StoredRule[] }>('POST', '/rules/reorder', { ids });
export const testRule = (rule: RuleDefinition) => api<DryRun>('POST', '/rules/test', rule);
export const applyRule = (id: string) => api<{ jobId: string }>('POST', `/rules/${id}/apply`);
export const fetchJob = (jobId: string) =>
  api<{
    state: string;
    progress: { done: number; total: number } | null;
    result: { matched: number } | null;
  }>('GET', `/rules/jobs/${jobId}`);
export const exportRules = () =>
  api<{ version: 1; rules: RuleDefinition[] }>('GET', '/rules/export');
export const importRules = (file: unknown, mode: 'append' | 'replace') =>
  api<{ imported: number }>('POST', '/rules/import', { ...(file as object), mode });
