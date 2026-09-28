import type { MessageKey } from '../i18n/fr';
import type { Action, Condition, TextField, TextOp } from '../api/rules';

export const TEXT_FIELDS: { value: TextField; key: MessageKey }[] = [
  { value: 'from', key: 'rules.field.from' },
  { value: 'to', key: 'rules.field.to' },
  { value: 'cc', key: 'rules.field.cc' },
  { value: 'subject', key: 'rules.field.subject' },
  { value: 'body_text', key: 'rules.field.body' },
  { value: 'attachment_name', key: 'rules.field.attachmentName' },
  { value: 'list_id', key: 'rules.field.listId' },
];

export const TEXT_OPS: { value: TextOp; key: MessageKey }[] = [
  { value: 'contains', key: 'rules.op.contains' },
  { value: 'not_contains', key: 'rules.op.notContains' },
  { value: 'equals', key: 'rules.op.equals' },
  { value: 'starts_with', key: 'rules.op.startsWith' },
  { value: 'ends_with', key: 'rules.op.endsWith' },
  { value: 'matches', key: 'rules.op.matches' },
];

export type ConditionKind = TextField | 'size' | 'has_attachment' | 'header';

export const ACTION_TYPES: { value: Action['type']; key: MessageKey }[] = [
  { value: 'add_label', key: 'rules.action.addLabel' },
  { value: 'remove_label', key: 'rules.action.removeLabel' },
  { value: 'mark_read', key: 'rules.action.markRead' },
  { value: 'star', key: 'rules.action.star' },
  { value: 'move', key: 'rules.action.move' },
  { value: 'archive', key: 'rules.action.archive' },
  { value: 'delete', key: 'rules.action.delete' },
  { value: 'forward', key: 'rules.action.forward' },
  { value: 'auto_reply', key: 'rules.action.autoReply' },
];

export function defaultCondition(kind: ConditionKind): Condition {
  if (kind === 'size') return { field: 'size', op: 'greater_than', value: 1_000_000 };
  if (kind === 'has_attachment') return { field: 'has_attachment', op: 'is', value: true };
  if (kind === 'header') return { field: 'header:x-spam-flag', op: 'equals', value: '' };
  return { field: kind, op: 'contains', value: '' };
}

export function defaultAction(type: Action['type']): Action {
  switch (type) {
    case 'move':
      return { type, folder: '' };
    case 'add_label':
    case 'remove_label':
      return { type, label: '' };
    case 'forward':
      return { type, to: '' };
    case 'auto_reply':
      return { type, subject: '', body: '' };
    default:
      return { type };
  }
}
