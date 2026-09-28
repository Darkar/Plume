/** File BullMQ du moteur de règles (partagée par l'API, producteur, et le worker, consommateur). */
export const RULES_QUEUE = 'plume-rules';

/** Canal Redis signalant au worker qu'un utilisateur a modifié ses règles. */
export const RULES_CHANGED_CHANNEL = 'plume:rules:changed';

export interface ProcessNewJob {
  userId: string;
  mailbox: string;
}

export interface ApplyExistingJob {
  userId: string;
  ruleId: string;
  mailbox: string;
}

export type RulesJobName = 'process-new' | 'apply-existing';
