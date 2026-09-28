import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { fetchFolders, mailKeys } from '../api/mail';
import { testRule, type Action, type Condition, type RuleDefinition } from '../api/rules';
import { Alert, Button, Checkbox, TextField as Field } from '../components/ui';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n/fr';
import {
  ACTION_TYPES,
  defaultAction,
  defaultCondition,
  TEXT_FIELDS,
  TEXT_OPS,
  type ConditionKind,
} from './labels';
import styles from './Rules.module.css';

const ISSUE_KEYS: Record<string, MessageKey> = {
  invalid_pattern: 'rules.issue.invalidPattern',
  forward_disabled: 'rules.issue.forwardDisabled',
  forward_destination_not_allowed: 'rules.issue.forwardNotAllowed',
  invalid_forward_address: 'rules.issue.invalidForward',
  conflicting_actions: 'rules.issue.conflicting',
};

/** Traduit les erreurs de validation renvoyées par le serveur. */
export function ruleErrorMessages(error: unknown, t: (key: MessageKey) => string): string[] {
  if (!(error instanceof ApiError)) return error ? [t('common.error.network')] : [];
  if (error.code === 'too_many_rules') return [t('rules.error.tooMany')];
  if (error.code === 'rules_disabled') return [t('rules.error.disabled')];
  if (error.code !== 'invalid_rule') return [t('common.error.generic')];
  const issues = Array.isArray(error.details.issues)
    ? (error.details.issues as { code?: string }[])
    : [];
  const messages = issues.map((issue) =>
    issue.code && ISSUE_KEYS[issue.code]
      ? t(ISSUE_KEYS[issue.code] as MessageKey)
      : t('rules.issue.invalid'),
  );
  return [...new Set(messages.length > 0 ? messages : [t('rules.issue.invalid')])];
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
  index,
  allowedHeaders,
}: {
  condition: Condition;
  onChange: (c: Condition) => void;
  onRemove: () => void;
  index: number;
  allowedHeaders: string[];
}) {
  const t = useT();
  const kind: ConditionKind =
    condition.field === 'size' || condition.field === 'has_attachment'
      ? condition.field
      : condition.field.startsWith('header:')
        ? 'header'
        : (condition.field as ConditionKind);
  const label = t('rules.condition.label', { n: index + 1 });
  return (
    <fieldset className={styles.row}>
      <legend className="visually-hidden">{label}</legend>
      <select
        aria-label={t('rules.condition.field')}
        value={kind}
        onChange={(e) => onChange(defaultCondition(e.target.value as ConditionKind))}
      >
        {TEXT_FIELDS.map((f) => (
          <option key={f.value} value={f.value}>
            {t(f.key)}
          </option>
        ))}
        <option value="size">{t('rules.field.size')}</option>
        <option value="has_attachment">{t('rules.field.hasAttachment')}</option>
        {allowedHeaders.length > 0 ? (
          <option value="header">{t('rules.field.header')}</option>
        ) : null}
      </select>
      {kind === 'header' && condition.field !== 'size' && condition.field !== 'has_attachment' ? (
        <select
          aria-label={t('rules.condition.headerName')}
          value={condition.field.slice(7)}
          onChange={(e) =>
            onChange({ ...condition, field: `header:${e.target.value}` } as Condition)
          }
        >
          {allowedHeaders.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
      ) : null}
      {condition.field === 'size' ? (
        <>
          <select
            aria-label={t('rules.condition.operator')}
            value={condition.op}
            onChange={(e) =>
              onChange({ ...condition, op: e.target.value as 'greater_than' | 'less_than' })
            }
          >
            <option value="greater_than">{t('rules.op.greaterThan')}</option>
            <option value="less_than">{t('rules.op.lessThan')}</option>
          </select>
          <input
            type="number"
            min={0}
            aria-label={t('rules.condition.sizeKb')}
            value={Math.round(condition.value / 1024)}
            onChange={(e) =>
              onChange({ ...condition, value: Math.max(0, Number(e.target.value)) * 1024 })
            }
          />
          <span>{t('rules.condition.kb')}</span>
        </>
      ) : condition.field === 'has_attachment' ? (
        <select
          aria-label={t('rules.condition.operator')}
          value={condition.value ? 'yes' : 'no'}
          onChange={(e) => onChange({ ...condition, value: e.target.value === 'yes' })}
        >
          <option value="yes">{t('rules.condition.yes')}</option>
          <option value="no">{t('rules.condition.no')}</option>
        </select>
      ) : (
        <>
          <select
            aria-label={t('rules.condition.operator')}
            value={condition.op}
            onChange={(e) => onChange({ ...condition, op: e.target.value as typeof condition.op })}
          >
            {TEXT_OPS.map((op) => (
              <option key={op.value} value={op.value}>
                {t(op.key)}
              </option>
            ))}
          </select>
          <input
            aria-label={t('rules.condition.value')}
            value={condition.value}
            maxLength={condition.op === 'matches' ? 256 : 500}
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
          />
        </>
      )}
      <Button
        variant="secondary"
        onClick={onRemove}
        aria-label={t('rules.condition.remove', { n: index + 1 })}
      >
        ✕
      </Button>
    </fieldset>
  );
}

function ActionRow({
  action,
  onChange,
  onRemove,
  index,
  folders,
}: {
  action: Action;
  onChange: (a: Action) => void;
  onRemove: () => void;
  index: number;
  folders: string[];
}) {
  const t = useT();
  return (
    <fieldset className={styles.row}>
      <legend className="visually-hidden">{t('rules.action.label', { n: index + 1 })}</legend>
      <select
        aria-label={t('rules.action.type')}
        value={action.type}
        onChange={(e) => onChange(defaultAction(e.target.value as Action['type']))}
      >
        {ACTION_TYPES.map((a) => (
          <option key={a.value} value={a.value}>
            {t(a.key)}
          </option>
        ))}
      </select>
      {action.type === 'move' ? (
        <select
          aria-label={t('rules.action.folder')}
          value={action.folder}
          onChange={(e) => onChange({ ...action, folder: e.target.value })}
        >
          <option value="">—</option>
          {folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      ) : null}
      {action.type === 'add_label' || action.type === 'remove_label' ? (
        <input
          aria-label={t('rules.action.labelName')}
          value={action.label}
          maxLength={64}
          onChange={(e) => onChange({ ...action, label: e.target.value })}
        />
      ) : null}
      {action.type === 'forward' ? (
        <input
          type="email"
          aria-label={t('rules.action.forwardTo')}
          value={action.to}
          maxLength={254}
          onChange={(e) => onChange({ ...action, to: e.target.value })}
        />
      ) : null}
      {action.type === 'auto_reply' ? (
        <div className={styles.autoReply}>
          <input
            aria-label={t('rules.action.replySubject')}
            placeholder={t('rules.action.replySubject')}
            value={action.subject}
            maxLength={200}
            onChange={(e) => onChange({ ...action, subject: e.target.value })}
          />
          <textarea
            aria-label={t('rules.action.replyBody')}
            placeholder={t('rules.action.replyBody')}
            value={action.body}
            rows={3}
            maxLength={5000}
            onChange={(e) => onChange({ ...action, body: e.target.value })}
          />
        </div>
      ) : null}
      <Button
        variant="secondary"
        onClick={onRemove}
        aria-label={t('rules.action.remove', { n: index + 1 })}
      >
        ✕
      </Button>
    </fieldset>
  );
}

/** Règle pré-remplie à partir d'un message (expéditeur, et objet s'il y en a un). */
export function ruleFromMessage(
  message: { subject: string; from: { name: string; address: string }[] },
  nameFor: (sender: string) => string,
): RuleDefinition {
  const sender = message.from[0];
  const subject = message.subject.trim().slice(0, 500);
  const conditions: Condition[] = [];
  if (sender?.address) conditions.push({ field: 'from', op: 'equals', value: sender.address });
  if (subject) conditions.push({ field: 'subject', op: 'contains', value: subject });
  if (conditions.length === 0) conditions.push({ field: 'from', op: 'contains', value: '' });
  const who = (sender?.name || sender?.address || '').slice(0, 80);
  return { ...EMPTY_RULE, name: who ? nameFor(who) : '', conditions };
}

export const EMPTY_RULE: RuleDefinition = {
  name: '',
  enabled: true,
  match: 'all',
  conditions: [{ field: 'from', op: 'contains', value: '' }],
  actions: [{ type: 'mark_read' }],
  stop_processing: false,
};

export function RuleEditor({
  initial,
  onSave,
  onCancel,
  saving,
  saveError,
  allowedHeaders = [],
}: {
  allowedHeaders?: string[];
  initial: RuleDefinition;
  onSave: (rule: RuleDefinition) => void;
  onCancel: () => void;
  saving: boolean;
  saveError: unknown;
}) {
  const t = useT();
  const titleId = useId();
  const [rule, setRule] = useState<RuleDefinition>(initial);
  const folders = useQuery({
    queryKey: mailKeys.folders,
    queryFn: fetchFolders,
    staleTime: 30_000,
  });
  const dryRun = useMutation({ mutationFn: () => testRule(rule) });
  const errors = ruleErrorMessages(saveError ?? dryRun.error, t);

  const set = (patch: Partial<RuleDefinition>) => setRule((r) => ({ ...r, ...patch }));
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSave(rule);
  };

  return (
    <form className={styles.editor} onSubmit={onSubmit} aria-labelledby={titleId}>
      <h2 id={titleId}>
        {initial.name ? t('rules.editor.editTitle') : t('rules.editor.newTitle')}
      </h2>
      {errors.length > 0 ? (
        <Alert>
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </Alert>
      ) : null}
      <Field
        label={t('rules.editor.name')}
        value={rule.name}
        maxLength={100}
        required
        onChange={(e) => set({ name: e.target.value })}
      />
      <div className={styles.section}>
        <label htmlFor={`${titleId}-match`}>{t('rules.editor.when')}</label>
        <select
          id={`${titleId}-match`}
          value={rule.match}
          onChange={(e) => set({ match: e.target.value as 'all' | 'any' })}
        >
          <option value="all">{t('rules.editor.matchAll')}</option>
          <option value="any">{t('rules.editor.matchAny')}</option>
        </select>
      </div>
      {rule.conditions.map((condition, index) => (
        <ConditionRow
          key={index}
          index={index}
          allowedHeaders={allowedHeaders}
          condition={condition}
          onChange={(c) =>
            set({ conditions: rule.conditions.map((x, i) => (i === index ? c : x)) })
          }
          onRemove={() => set({ conditions: rule.conditions.filter((_, i) => i !== index) })}
        />
      ))}
      <div>
        <Button
          variant="link"
          disabled={rule.conditions.length >= 20}
          onClick={() => set({ conditions: [...rule.conditions, defaultCondition('subject')] })}
        >
          {t('rules.editor.addCondition')}
        </Button>
      </div>
      <h3 className={styles.subTitle}>{t('rules.editor.then')}</h3>
      {rule.actions.map((action, index) => (
        <ActionRow
          key={index}
          index={index}
          action={action}
          folders={(folders.data?.folders ?? []).map((f) => f.path)}
          onChange={(a) => set({ actions: rule.actions.map((x, i) => (i === index ? a : x)) })}
          onRemove={() => set({ actions: rule.actions.filter((_, i) => i !== index) })}
        />
      ))}
      <div>
        <Button
          variant="link"
          disabled={rule.actions.length >= 10}
          onClick={() => set({ actions: [...rule.actions, defaultAction('add_label')] })}
        >
          {t('rules.editor.addAction')}
        </Button>
      </div>
      <Checkbox
        label={t('rules.editor.stop')}
        checked={rule.stop_processing}
        onChange={(e) => set({ stop_processing: e.target.checked })}
      />
      <Checkbox
        label={t('rules.editor.enabled')}
        checked={rule.enabled}
        onChange={(e) => set({ enabled: e.target.checked })}
      />
      {dryRun.data ? (
        <div className={styles.dryRun} role="status">
          <p>
            {t('rules.test.result', {
              count: dryRun.data.matches.length,
              tested: dryRun.data.tested,
            })}
          </p>
          <ul>
            {dryRun.data.matches.slice(0, 20).map((m) => (
              <li key={m.id}>
                <strong>{m.from[0]?.name || m.from[0]?.address}</strong> — {m.subject}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className={styles.buttons}>
        <Button type="submit" disabled={saving}>
          {t('rules.editor.save')}
        </Button>
        <Button variant="secondary" onClick={() => dryRun.mutate()} disabled={dryRun.isPending}>
          {dryRun.isPending ? t('rules.test.running') : t('rules.test.button')}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t('common.action.cancel')}
        </Button>
      </div>
    </form>
  );
}
