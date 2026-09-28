import { z } from 'zod';

/**
 * Modèle des règles (bibliothèque pure, sans I/O). Un seul schéma Zod sert à la validation des
 * entrées de l'API, à l'import JSON et au typage.
 */

export const MAX_CONDITIONS = 20;
export const MAX_ACTIONS = 10;
export const MAX_VALUE_LENGTH = 500;
export const MAX_PATTERN_LENGTH = 256;

/** En-têtes lisibles par une règle (`header:<nom>`) : liste fermée. */
export const ALLOWED_HEADERS = [
  'auto-submitted',
  'delivered-to',
  'importance',
  'list-id',
  'list-unsubscribe',
  'precedence',
  'reply-to',
  'return-path',
  'sender',
  'x-mailer',
  'x-original-to',
  'x-priority',
  'x-spam-flag',
  'x-spam-level',
  'x-spam-status',
] as const;

export const TEXT_FIELDS = [
  'from',
  'to',
  'cc',
  'subject',
  'body_text',
  'attachment_name',
  'list_id',
] as const;
export const TEXT_OPERATORS = [
  'contains',
  'not_contains',
  'equals',
  'starts_with',
  'ends_with',
  'matches',
] as const;

const textValue = z.string().trim().min(1).max(MAX_VALUE_LENGTH);

const headerField = z
  .string()
  .regex(/^header:[a-z0-9-]{1,64}$/i)
  .transform((value) => value.toLowerCase() as `header:${string}`)
  .refine((value) => (ALLOWED_HEADERS as readonly string[]).includes(value.slice(7)), {
    message: 'en-tête non autorisé',
  });

const textCondition = z.strictObject({
  field: z.union([z.enum(TEXT_FIELDS), headerField]),
  op: z.enum(TEXT_OPERATORS),
  value: textValue,
});

const sizeCondition = z.strictObject({
  field: z.literal('size'),
  op: z.enum(['greater_than', 'less_than']),
  value: z
    .number()
    .int()
    .min(0)
    .max(2 ** 40),
});

const attachmentCondition = z.strictObject({
  field: z.literal('has_attachment'),
  op: z.literal('is'),
  value: z.boolean(),
});

export const conditionSchema = z
  .union([sizeCondition, attachmentCondition, textCondition])
  .superRefine((condition, ctx) => {
    if (
      condition.op === 'matches' &&
      typeof condition.value === 'string' &&
      condition.value.length > MAX_PATTERN_LENGTH
    ) {
      ctx.addIssue({ code: 'custom', message: 'expression trop longue', path: ['value'] });
    }
  });

const folderName = z.string().trim().min(1).max(500);
const label = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/);

export const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('move'), folder: folderName }),
  z.strictObject({ type: z.literal('archive') }),
  z.strictObject({ type: z.literal('add_label'), label }),
  z.strictObject({ type: z.literal('remove_label'), label }),
  z.strictObject({ type: z.literal('mark_read') }),
  z.strictObject({ type: z.literal('star') }),
  z.strictObject({ type: z.literal('delete') }),
  z.strictObject({ type: z.literal('forward'), to: z.string().trim().toLowerCase().max(254) }),
  z.strictObject({
    type: z.literal('auto_reply'),
    subject: z.string().trim().max(200).default(''),
    body: z.string().trim().min(1).max(5000),
  }),
]);

export const ruleSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(conditionSchema).min(1).max(MAX_CONDITIONS),
  actions: z.array(actionSchema).min(1).max(MAX_ACTIONS),
  stop_processing: z.boolean().default(false),
});

/** Fichier d'import / export : liste de règles, dans l'ordre d'exécution. */
export const rulesFileSchema = z.strictObject({
  version: z.literal(1),
  rules: z.array(ruleSchema).max(1000),
});

export type Condition = z.output<typeof conditionSchema>;
export type Action = z.output<typeof actionSchema>;
export type Rule = z.output<typeof ruleSchema>;
export type RuleInput = z.input<typeof ruleSchema>;

export interface Address {
  name: string;
  address: string;
}

/** Faits extraits d'un message, sur lesquels les règles sont évaluées. */
export interface MessageFacts {
  from: Address[];
  to: Address[];
  cc: Address[];
  subject: string;
  bodyText: string;
  attachments: { filename: string }[];
  size: number;
  /** En-têtes (noms en minuscules), limités à ALLOWED_HEADERS par l'extracteur. */
  headers: Record<string, string[]>;
}
