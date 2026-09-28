import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { DbHandle } from './client.js';
import * as schema from './schema.js';

export interface NewSnooze {
  folder: string;
  uidValidity: number;
  uid: number;
  messageId: string | null;
  returnTo: string;
  wakeAt: Date;
}

/** Reports de messages. Toutes les requêtes utilisateur portent sur `user_id`. */
export class SnoozesRepository {
  constructor(private readonly db: DbHandle['db']) {}

  async create(userId: string, snooze: NewSnooze): Promise<schema.Snooze> {
    const [row] = await this.db
      .insert(schema.snoozes)
      .values({ userId, ...snooze })
      .onConflictDoUpdate({
        target: [
          schema.snoozes.userId,
          schema.snoozes.folder,
          schema.snoozes.uidValidity,
          schema.snoozes.uid,
        ],
        set: { wakeAt: snooze.wakeAt, returnTo: snooze.returnTo, attempts: 0 },
      })
      .returning();
    return row as schema.Snooze;
  }

  /** Report correspondant à une position de message (dossier des reports). */
  async find(userId: string, folder: string, uidValidity: number, uid: number) {
    const [row] = await this.db
      .select()
      .from(schema.snoozes)
      .where(
        and(
          eq(schema.snoozes.userId, userId),
          eq(schema.snoozes.folder, folder),
          eq(schema.snoozes.uidValidity, uidValidity),
          eq(schema.snoozes.uid, uid),
        ),
      );
    return row ?? null;
  }

  async listForUser(userId: string): Promise<schema.Snooze[]> {
    return this.db
      .select()
      .from(schema.snoozes)
      .where(eq(schema.snoozes.userId, userId))
      .orderBy(asc(schema.snoozes.wakeAt));
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(schema.snoozes)
      .where(and(eq(schema.snoozes.userId, userId), eq(schema.snoozes.id, id)))
      .returning({ id: schema.snoozes.id });
    return rows.length === 1;
  }

  /** Reports arrivés à échéance (tous utilisateurs), pour le worker. */
  async due(now: Date, limit = 100): Promise<schema.Snooze[]> {
    return this.db
      .select()
      .from(schema.snoozes)
      .where(lte(schema.snoozes.wakeAt, now))
      .orderBy(asc(schema.snoozes.wakeAt))
      .limit(limit);
  }

  /** Échec de réveil : nouvel essai plus tard (délai croissant, abandon après 10 essais). */
  async postpone(id: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE snoozes SET attempts = attempts + 1,
        wake_at = now() + make_interval(mins => least(60, power(2, attempts)::int))
      WHERE id = ${id}`);
    await this.db.execute(sql`DELETE FROM snoozes WHERE id = ${id} AND attempts >= 10`);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(schema.snoozes).where(eq(schema.snoozes.id, id));
  }
}
