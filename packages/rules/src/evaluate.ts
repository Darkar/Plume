import { RE2 } from 're2-wasm';
import type { Action, Address, Condition, MessageFacts, Rule } from './model.js';

/** Longueur maximale du texte examiné (corps, sujet…) : borne le coût de toute évaluation. */
export const MAX_TEXT_LENGTH = 100_000;
/** Budget de temps par message pour l'ensemble des règles. */
export const EVALUATION_BUDGET_MS = 250;

export class RuleEvaluationError extends Error {
  constructor(readonly code: 'invalid_pattern' | 'budget_exceeded') {
    super(code);
    this.name = 'RuleEvaluationError';
  }
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

const patternCache = new Map<string, RE2>();

/**
 * Compile une expression avec RE2 (temps linéaire garanti : pas de retour arrière, donc pas de
 * ReDoS). Les expressions sont insensibles à la casse et en mode Unicode.
 */
export function compilePattern(pattern: string): RE2 {
  const cached = patternCache.get(pattern);
  if (cached) return cached;
  let compiled: RE2;
  try {
    compiled = new RE2(pattern, 'iu');
  } catch {
    throw new RuleEvaluationError('invalid_pattern');
  }
  if (patternCache.size >= 1000) {
    const oldest = patternCache.keys().next().value as string;
    patternCache.delete(oldest);
  }
  patternCache.set(pattern, compiled);
  return compiled;
}

export function isValidPattern(pattern: string): boolean {
  try {
    compilePattern(pattern);
    return true;
  } catch {
    return false;
  }
}

function addressCandidates(list: Address[]): string[] {
  return list.flatMap((a) =>
    a.name ? [a.address, a.name, `${a.name} <${a.address}>`] : [a.address],
  );
}

function candidates(condition: Condition, facts: MessageFacts): string[] {
  switch (condition.field) {
    case 'from':
      return addressCandidates(facts.from);
    case 'to':
      return addressCandidates(facts.to);
    case 'cc':
      return addressCandidates(facts.cc);
    case 'subject':
      return [facts.subject];
    case 'body_text':
      return [facts.bodyText];
    case 'attachment_name':
      return facts.attachments.map((a) => a.filename);
    case 'list_id':
      return facts.headers['list-id'] ?? [];
    default:
      if (typeof condition.field === 'string' && condition.field.startsWith('header:')) {
        return facts.headers[condition.field.slice(7)] ?? [];
      }
      return [];
  }
}

function textMatches(op: string, value: string, texts: string[]): boolean {
  const needle = normalize(value);
  const haystacks = texts.map((t) => normalize(t.slice(0, MAX_TEXT_LENGTH)));
  switch (op) {
    case 'contains':
      return haystacks.some((h) => h.includes(needle));
    case 'not_contains':
      return haystacks.every((h) => !h.includes(needle));
    case 'equals':
      return haystacks.some((h) => h.trim() === needle);
    case 'starts_with':
      return haystacks.some((h) => h.trim().startsWith(needle));
    case 'ends_with':
      return haystacks.some((h) => h.trim().endsWith(needle));
    case 'matches': {
      const regex = compilePattern(value);
      return texts.some((t) => regex.test(t.slice(0, MAX_TEXT_LENGTH).normalize('NFKC')));
    }
    default:
      return false;
  }
}

export function evaluateCondition(condition: Condition, facts: MessageFacts): boolean {
  if (condition.field === 'size') {
    return condition.op === 'greater_than'
      ? facts.size > condition.value
      : facts.size < condition.value;
  }
  if (condition.field === 'has_attachment') {
    return facts.attachments.length > 0 === condition.value;
  }
  return textMatches(condition.op, condition.value as string, candidates(condition, facts));
}

export function evaluateRule(rule: Rule, facts: MessageFacts): boolean {
  if (!rule.enabled) return false;
  return rule.match === 'all'
    ? rule.conditions.every((c) => evaluateCondition(c, facts))
    : rule.conditions.some((c) => evaluateCondition(c, facts));
}

export interface RuleOutcome {
  /** Indices (dans la liste fournie) des règles qui correspondent. */
  matched: number[];
  /** Actions à appliquer, dans l'ordre. */
  actions: Action[];
  /** Règles dont l'évaluation a échoué (expression invalide, budget dépassé). */
  errors: { index: number; code: RuleEvaluationError['code'] }[];
}

/**
 * Évalue les règles dans l'ordre. Une règle avec `stop_processing` arrête l'évaluation des
 * suivantes quand elle correspond. Le budget de temps protège le worker d'un message ou d'un
 * ensemble de règles pathologique.
 */
export function evaluateRules(
  rules: Rule[],
  facts: MessageFacts,
  options: { budgetMs?: number; now?: () => number } = {},
): RuleOutcome {
  const now = options.now ?? (() => performance.now());
  const deadline = now() + (options.budgetMs ?? EVALUATION_BUDGET_MS);
  const outcome: RuleOutcome = { matched: [], actions: [], errors: [] };
  for (const [index, rule] of rules.entries()) {
    if (now() > deadline) {
      outcome.errors.push({ index, code: 'budget_exceeded' });
      break;
    }
    let matched: boolean;
    try {
      matched = evaluateRule(rule, facts);
    } catch (error) {
      outcome.errors.push({
        index,
        code: error instanceof RuleEvaluationError ? error.code : 'invalid_pattern',
      });
      continue;
    }
    if (!matched) continue;
    outcome.matched.push(index);
    outcome.actions.push(...rule.actions);
    if (rule.stop_processing) break;
  }
  return outcome;
}
