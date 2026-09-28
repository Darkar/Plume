import { createHash } from 'node:crypto';
import { ruleSchema, type Rule } from '@plume/rules';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { DbHandle } from './client.js';
import * as schema from './schema.js';

type Db = DbHandle['db'];

export interface StoredRule {
  id: string;
  position: number;
  rule: Rule;
  stats: {
    lastRunAt: string | null;
    processedCount: number;
    errorCount: number;
    lastError: string | null;
    lastErrorAt: string | null;
  };
}

function toStored(row: schema.RuleRow): StoredRule | null {
  // La définition est revalidée à la lecture : une ligne corrompue n'est jamais exécutée.
  const parsed = ruleSchema.safeParse(row.definition);
  if (!parsed.success) return null;
  return {
    id: row.id,
    position: row.position,
    rule: parsed.data,
    stats: {
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      processedCount: row.processedCount,
      errorCount: row.errorCount,
      lastError: row.lastError,
      lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    },
  };
}

/**
 * Persistance des règles. Toutes les requêtes portent sur `user_id` : un utilisateur ne peut ni
 * lire ni modifier les règles d'un autre (contrôle d'accès au niveau des données).
 */
export class RulesRepository {
  constructor(private readonly db: Db) {}

  async list(userId: string): Promise<StoredRule[]> {
    const rows = await this.db
      .select()
      .from(schema.rules)
      .where(eq(schema.rules.userId, userId))
      .orderBy(asc(schema.rules.position), asc(schema.rules.createdAt));
    return rows.map(toStored).filter((r): r is StoredRule => r !== null);
  }

  async get(userId: string, id: string): Promise<StoredRule | null> {
    const [row] = await this.db
      .select()
      .from(schema.rules)
      .where(and(eq(schema.rules.userId, userId), eq(schema.rules.id, id)));
    return row ? toStored(row) : null;
  }

  async count(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.rules)
      .where(eq(schema.rules.userId, userId));
    return row?.n ?? 0;
  }

  async create(userId: string, rule: Rule): Promise<StoredRule> {
    const [row] = await this.db
      .insert(schema.rules)
      .values({
        userId,
        definition: rule,
        position: sql`coalesce((SELECT max(position) + 1 FROM rules WHERE user_id = ${userId}), 0)`,
      })
      .returning();
    return toStored(row as schema.RuleRow) as StoredRule;
  }

  async update(userId: string, id: string, rule: Rule): Promise<StoredRule | null> {
    const [row] = await this.db
      .update(schema.rules)
      .set({ definition: rule, updatedAt: new Date() })
      .where(and(eq(schema.rules.userId, userId), eq(schema.rules.id, id)))
      .returning();
    return row ? toStored(row) : null;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(schema.rules)
      .where(and(eq(schema.rules.userId, userId), eq(schema.rules.id, id)))
      .returning({ id: schema.rules.id });
    return rows.length === 1;
  }

  /** Réordonne : `ids` doit contenir exactement toutes les règles de l'utilisateur. */
  async reorder(userId: string, ids: string[]): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: schema.rules.id })
        .from(schema.rules)
        .where(eq(schema.rules.userId, userId))
        .for('update');
      const current = new Set(rows.map((r) => r.id));
      if (
        ids.length !== current.size ||
        new Set(ids).size !== ids.length ||
        !ids.every((id) => current.has(id))
      ) {
        return false;
      }
      for (const [position, id] of ids.entries()) {
        await tx
          .update(schema.rules)
          .set({ position })
          .where(and(eq(schema.rules.userId, userId), eq(schema.rules.id, id)));
      }
      return true;
    });
  }

  /** Remplace ou ajoute des règles (import JSON), dans une transaction. */
  async importRules(userId: string, rules: Rule[], mode: 'append' | 'replace'): Promise<number> {
    return this.db.transaction(async (tx) => {
      if (mode === 'replace') await tx.delete(schema.rules).where(eq(schema.rules.userId, userId));
      const [max] = await tx
        .select({ p: sql<number>`coalesce(max(position) + 1, 0)::int` })
        .from(schema.rules)
        .where(eq(schema.rules.userId, userId));
      const start = max?.p ?? 0;
      if (rules.length > 0) {
        await tx
          .insert(schema.rules)
          .values(rules.map((rule, i) => ({ userId, definition: rule, position: start + i })));
      }
      return rules.length;
    });
  }

  /** Utilisateurs ayant au moins une règle active (et un compte non suspendu). */
  async usersWithActiveRules(): Promise<string[]> {
    const rows = await this.db.execute<{ user_id: string }>(sql`
      SELECT DISTINCT r.user_id
      FROM rules r JOIN users u ON u.id = r.user_id
      WHERE u.suspended_at IS NULL AND (r.definition->>'enabled')::boolean IS TRUE`);
    return rows.rows.map((r) => r.user_id);
  }

  async recordRun(userId: string, ruleIds: string[], processed: number): Promise<void> {
    if (ruleIds.length === 0) return;
    await this.db
      .update(schema.rules)
      .set({
        lastRunAt: new Date(),
        processedCount: sql`${schema.rules.processedCount} + ${processed}`,
      })
      .where(and(eq(schema.rules.userId, userId), inArray(schema.rules.id, ruleIds)));
  }

  async recordError(userId: string, ruleId: string, code: string): Promise<void> {
    await this.db
      .update(schema.rules)
      .set({
        errorCount: sql`${schema.rules.errorCount} + 1`,
        lastError: code.slice(0, 64),
        lastErrorAt: new Date(),
      })
      .where(and(eq(schema.rules.userId, userId), eq(schema.rules.id, ruleId)));
  }

  // --- Idempotence et curseurs ---------------------------------------------------------------

  /** Réserve un message pour traitement ; renvoie false s'il a déjà été traité. */
  async claimMessage(
    userId: string,
    mailbox: string,
    uidValidity: number,
    uid: number,
  ): Promise<boolean> {
    const rows = await this.db
      .insert(schema.processedMessages)
      .values({ userId, mailbox, uidValidity, uid })
      .onConflictDoNothing()
      .returning({ uid: schema.processedMessages.uid });
    return rows.length === 1;
  }

  /**
   * Réserve un Message-ID ; renvoie false s'il a déjà été traité (message remis dans la boîte
   * avec un nouvel UID). Seule l'empreinte est conservée.
   */
  async claimMessageId(userId: string, messageId: string): Promise<boolean> {
    const hash = createHash('sha256').update(messageId.trim().toLowerCase()).digest();
    const rows = await this.db.execute<{ user_id: string }>(sql`
      INSERT INTO processed_message_ids (user_id, message_hash) VALUES (${userId}, ${hash})
      ON CONFLICT DO NOTHING RETURNING user_id`);
    return rows.rows.length === 1;
  }

  async getCursor(userId: string, mailbox: string) {
    const [row] = await this.db
      .select()
      .from(schema.ruleCursors)
      .where(and(eq(schema.ruleCursors.userId, userId), eq(schema.ruleCursors.mailbox, mailbox)));
    return row ?? null;
  }

  async setCursor(
    userId: string,
    mailbox: string,
    uidValidity: number,
    lastUid: number,
  ): Promise<void> {
    await this.db
      .insert(schema.ruleCursors)
      .values({ userId, mailbox, uidValidity, lastUid })
      .onConflictDoUpdate({
        target: [schema.ruleCursors.userId, schema.ruleCursors.mailbox],
        set: { uidValidity, lastUid, updatedAt: new Date() },
      });
  }

  /** Purge des traces d'idempotence anciennes (les curseurs suffisent au-delà). */
  async purgeProcessed(olderThanDays: number): Promise<number> {
    await this.db.execute(
      sql`DELETE FROM processed_message_ids WHERE processed_at < now() - make_interval(days => ${olderThanDays})`,
    );
    const rows = await this.db
      .delete(schema.processedMessages)
      .where(
        lt(
          schema.processedMessages.processedAt,
          sql`now() - make_interval(days => ${olderThanDays})`,
        ),
      )
      .returning({ uid: schema.processedMessages.uid });
    return rows.length;
  }

  /**
   * Réserve le droit d'envoyer une réponse automatique à un expéditeur : au plus une par 24 h.
   * Atomique (INSERT … ON CONFLICT … WHERE) : deux traitements simultanés ne répondent qu'une fois.
   */
  async claimAutoReply(userId: string, sender: string): Promise<boolean> {
    const rows = await this.db.execute<{ sender: string }>(sql`
      INSERT INTO auto_replies (user_id, sender, sent_at) VALUES (${userId}, ${sender.toLowerCase()}, now())
      ON CONFLICT (user_id, sender) DO UPDATE SET sent_at = now()
      WHERE auto_replies.sent_at < now() - interval '24 hours'
      RETURNING sender`);
    return rows.rows.length === 1;
  }
}
