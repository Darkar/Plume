import type { DbHandle } from '@plume/db';
import { schema } from '@plume/db';
import { redactSensitive } from '@plume/shared';
import type { Logger } from 'pino';

export type AuditEvent =
  | 'login_success'
  | 'login_failure'
  | 'logout'
  | 'logout_all'
  | 'totp_success'
  | 'totp_failure'
  | 'totp_enabled'
  | 'totp_disabled'
  | 'backup_code_used'
  | 'backup_codes_regenerated'
  | 'session_revoked'
  | 'account_suspended'
  | 'rule_created'
  | 'rule_updated'
  | 'rule_deleted'
  | 'rules_reordered'
  | 'rules_imported'
  | 'preferences_updated'
  | 'account_added'
  | 'account_switched'
  | 'account_removed';

export interface AuditEntry {
  event: AuditEvent;
  userId?: string | null;
  subject?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

/** Journal d'audit en base. Les métadonnées passent par le masquage des champs sensibles. */
export class AuditLog {
  constructor(
    private readonly db: DbHandle['db'],
    private readonly logger: Logger,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    const metadata = redactSensitive(entry.metadata ?? {}) as Record<string, unknown>;
    try {
      await this.db.insert(schema.auditLog).values({
        event: entry.event,
        userId: entry.userId ?? null,
        subject: entry.subject ? entry.subject.slice(0, 254) : null,
        ip: entry.ip ?? null,
        metadata,
      });
    } catch (error) {
      // L'audit ne doit pas bloquer l'action, mais son échec doit être visible.
      this.logger.error({ err: error, event: entry.event }, "échec d'écriture du journal d'audit");
    }
  }
}
