import { isValidPattern } from './evaluate.js';
import type { Address, MessageFacts, Rule } from './model.js';

/** Contexte de validation issu de la configuration (liste des domaines de transfert…). */
export interface RulePolicy {
  forwardEnabled: boolean;
  /** Domaines exacts ou « *.domaine », déjà normalisés. Vide = transfert interdit. */
  forwardDomains: readonly string[];
}

export type RuleIssue =
  | { code: 'invalid_pattern'; conditionIndex: number }
  | { code: 'forward_disabled'; actionIndex: number }
  | { code: 'forward_destination_not_allowed'; actionIndex: number }
  | { code: 'invalid_forward_address'; actionIndex: number }
  | { code: 'conflicting_actions' };

const ADDRESS_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9.-]+$/;

export function domainAllowed(domain: string, patterns: readonly string[]): boolean {
  const d = domain.toLowerCase();
  return patterns.some((pattern) =>
    pattern.startsWith('*.')
      ? d.endsWith(pattern.slice(1)) && d.length > pattern.length - 1
      : d === pattern,
  );
}

/** Contrôles au-delà du schéma : expressions RE2 valides, transferts autorisés, cohérence. */
export function checkRule(rule: Rule, policy: RulePolicy): RuleIssue[] {
  const issues: RuleIssue[] = [];
  rule.conditions.forEach((condition, conditionIndex) => {
    if (condition.op === 'matches' && !isValidPattern(condition.value as string)) {
      issues.push({ code: 'invalid_pattern', conditionIndex });
    }
  });
  rule.actions.forEach((action, actionIndex) => {
    if (action.type !== 'forward') return;
    if (!policy.forwardEnabled || policy.forwardDomains.length === 0) {
      issues.push({ code: 'forward_disabled', actionIndex });
      return;
    }
    const at = action.to.lastIndexOf('@');
    if (!ADDRESS_RE.test(action.to) || at <= 0 || action.to.indexOf('@') !== at) {
      issues.push({ code: 'invalid_forward_address', actionIndex });
      return;
    }
    if (!domainAllowed(action.to.slice(at + 1), policy.forwardDomains)) {
      issues.push({ code: 'forward_destination_not_allowed', actionIndex });
    }
  });
  const moves = rule.actions.filter(
    (a) => a.type === 'move' || a.type === 'archive' || a.type === 'delete',
  );
  if (moves.length > 1) issues.push({ code: 'conflicting_actions' });
  return issues;
}

const NO_REPLY_RE =
  /(^|[._+-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?)([._+-]|@)/i;

function isNoReply(address: Address | undefined): boolean {
  if (!address) return true;
  return NO_REPLY_RE.test(address.address) || /^(mailer-daemon|postmaster)@/i.test(address.address);
}

/**
 * Une réponse automatique n'est jamais envoyée à une liste de diffusion, à un message
 * automatique (RFC 3834) ni à une adresse « noreply », ni à soi-même.
 */
export function canAutoReply(facts: MessageFacts, self: string): boolean {
  const headers = facts.headers;
  if ((headers['list-id']?.length ?? 0) > 0 || (headers['list-unsubscribe']?.length ?? 0) > 0)
    return false;
  const precedence = (headers.precedence ?? []).map((v) => v.trim().toLowerCase());
  if (precedence.some((p) => ['bulk', 'list', 'junk', 'auto_reply'].includes(p))) return false;
  const autoSubmitted = (headers['auto-submitted'] ?? []).map((v) => v.trim().toLowerCase());
  if (autoSubmitted.some((v) => v !== 'no')) return false;
  const sender = facts.from[0];
  if (isNoReply(sender)) return false;
  return sender?.address.toLowerCase() !== self.toLowerCase();
}

/** Anti-boucle du transfert : un message déjà transféré par Plume ou automatique n'est pas re-transféré. */
export function canForward(facts: MessageFacts, rawHeaders: Record<string, string[]>): boolean {
  if ((rawHeaders['x-plume-forwarded']?.length ?? 0) > 0) return false;
  const autoSubmitted = (facts.headers['auto-submitted'] ?? []).map((v) => v.trim().toLowerCase());
  return !autoSubmitted.some((v) => v !== 'no');
}
