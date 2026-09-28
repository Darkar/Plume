import type { SecretBox } from '@plume/crypto';
import { generateBackupCodes, hashSecret, normalizeBackupCode, verifySecret } from '@plume/crypto';
import { schema, type DbHandle, type User } from '@plume/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

type Db = DbHandle['db'];

const CONTEXT_IMAP = 'imap-password';
const CONTEXT_TOTP = 'totp-secret';

/** Accès aux utilisateurs et à leurs secrets. Toutes les requêtes sont paramétrées (Drizzle). */
export class UserService {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  /** Crée ou met à jour l'utilisateur après un LOGIN IMAP réussi. */
  async recordLogin(email: string, domain: string): Promise<User> {
    const [user] = await this.db
      .insert(schema.users)
      .values({ email, domain, lastLoginAt: new Date() })
      .onConflictDoUpdate({
        target: schema.users.email,
        set: { lastLoginAt: new Date(), suspendedAt: null, domain },
      })
      .returning();
    return user as User;
  }

  async get(userId: string): Promise<User | null> {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, userId));
    return user ?? null;
  }

  /** Conserve le mot de passe IMAP chiffré pour le moteur de règles. */
  async storeImapPassword(userId: string, password: string): Promise<void> {
    const secret = this.box.encrypt(userId, CONTEXT_IMAP, password);
    await this.db
      .insert(schema.credentials)
      .values({ userId, secret, keyId: this.box.keyId })
      .onConflictDoUpdate({
        target: schema.credentials.userId,
        set: { secret, keyId: this.box.keyId, updatedAt: new Date() },
      });
  }

  async readImapPassword(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select()
      .from(schema.credentials)
      .where(eq(schema.credentials.userId, userId));
    return row ? this.box.decrypt(userId, CONTEXT_IMAP, row.secret) : null;
  }

  async hasTotp(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ userId: schema.totp.userId })
      .from(schema.totp)
      .where(eq(schema.totp.userId, userId));
    return row !== undefined;
  }

  async getTotp(userId: string): Promise<{ secret: string; lastUsedStep: number | null } | null> {
    const [row] = await this.db.select().from(schema.totp).where(eq(schema.totp.userId, userId));
    if (!row) return null;
    return {
      secret: this.box.decrypt(userId, CONTEXT_TOTP, row.secret),
      lastUsedStep: row.lastUsedStep,
    };
  }

  /**
   * Enregistre le pas de temps utilisé, de façon atomique : si deux requêtes présentent le même
   * code en parallèle, une seule réussit (anti-rejeu).
   */
  async consumeTotpStep(userId: string, step: number): Promise<boolean> {
    const updated = await this.db
      .update(schema.totp)
      .set({ lastUsedStep: step })
      .where(
        and(
          eq(schema.totp.userId, userId),
          sql`(${schema.totp.lastUsedStep} IS NULL OR ${schema.totp.lastUsedStep} < ${step})`,
        ),
      )
      .returning({ userId: schema.totp.userId });
    return updated.length === 1;
  }

  /** Active le TOTP et renvoie les codes de secours en clair (affichés une seule fois). */
  async enableTotp(userId: string, secret: string, step: number): Promise<string[]> {
    const codes = generateBackupCodes(10);
    const hashes = await Promise.all(codes.map((code) => hashSecret(code)));
    await this.db.transaction(async (tx) => {
      await tx
        .insert(schema.totp)
        .values({
          userId,
          secret: this.box.encrypt(userId, CONTEXT_TOTP, secret),
          keyId: this.box.keyId,
          lastUsedStep: step,
        })
        .onConflictDoNothing();
      await tx.delete(schema.backupCodes).where(eq(schema.backupCodes.userId, userId));
      await tx.insert(schema.backupCodes).values(hashes.map((codeHash) => ({ userId, codeHash })));
    });
    return codes;
  }

  async disableTotp(userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(schema.totp).where(eq(schema.totp.userId, userId));
      await tx.delete(schema.backupCodes).where(eq(schema.backupCodes.userId, userId));
    });
  }

  async regenerateBackupCodes(userId: string): Promise<string[]> {
    const codes = generateBackupCodes(10);
    const hashes = await Promise.all(codes.map((code) => hashSecret(code)));
    await this.db.transaction(async (tx) => {
      await tx.delete(schema.backupCodes).where(eq(schema.backupCodes.userId, userId));
      await tx.insert(schema.backupCodes).values(hashes.map((codeHash) => ({ userId, codeHash })));
    });
    return codes;
  }

  async remainingBackupCodes(userId: string): Promise<number> {
    const rows = await this.db
      .select({ id: schema.backupCodes.id })
      .from(schema.backupCodes)
      .where(and(eq(schema.backupCodes.userId, userId), isNull(schema.backupCodes.usedAt)));
    return rows.length;
  }

  /** Consomme un code de secours (usage unique). */
  async useBackupCode(userId: string, input: string): Promise<boolean> {
    const code = normalizeBackupCode(input);
    if (!code) return false;
    const rows = await this.db
      .select()
      .from(schema.backupCodes)
      .where(and(eq(schema.backupCodes.userId, userId), isNull(schema.backupCodes.usedAt)));
    for (const row of rows) {
      if (await verifySecret(row.codeHash, code)) {
        const used = await this.db
          .update(schema.backupCodes)
          .set({ usedAt: new Date() })
          .where(and(eq(schema.backupCodes.id, row.id), isNull(schema.backupCodes.usedAt)))
          .returning({ id: schema.backupCodes.id });
        return used.length === 1;
      }
    }
    return false;
  }

  /** Domaines distincts des comptes actifs (pour la révocation au rechargement de la config). */
  async activeDomains(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ domain: schema.users.domain })
      .from(schema.users)
      .where(isNull(schema.users.suspendedAt));
    return rows.map((r) => r.domain);
  }

  /** Suspend les comptes d'un domaine retiré de la liste blanche ; renvoie leurs identifiants. */
  async suspendDomain(domain: string): Promise<string[]> {
    const rows = await this.db
      .update(schema.users)
      .set({ suspendedAt: new Date() })
      .where(and(eq(schema.users.domain, domain), isNull(schema.users.suspendedAt)))
      .returning({ id: schema.users.id });
    return rows.map((r) => r.id);
  }

  /** Comptes actifs d'un domaine (contrôle des comptes autorisés après un rechargement). */
  async activeAccounts(domain: string): Promise<{ id: string; email: string }[]> {
    return this.db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(and(eq(schema.users.domain, domain), isNull(schema.users.suspendedAt)));
  }

  /** Suspend les comptes donnés (retirés de la liste des comptes autorisés). */
  async suspendUsers(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .update(schema.users)
      .set({ suspendedAt: new Date() })
      .where(and(inArray(schema.users.id, ids), isNull(schema.users.suspendedAt)))
      .returning({ id: schema.users.id });
    return rows.map((r) => r.id);
  }
}
