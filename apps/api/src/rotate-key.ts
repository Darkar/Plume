import type { SecretBox } from '@plume/crypto';
import { schema, type DbHandle } from '@plume/db';
import { eq } from 'drizzle-orm';

const CONTEXTS = { credentials: 'imap-password', totp: 'totp-secret' } as const;

export interface RotationResult {
  credentials: number;
  totp: number;
}

/**
 * Rechiffre tous les secrets avec une nouvelle clé maître, dans une seule transaction :
 * en cas d'erreur (clé actuelle incorrecte, donnée altérée…), rien n'est modifié.
 */
export async function rotateMasterKey(
  handle: DbHandle,
  current: SecretBox,
  next: SecretBox,
): Promise<RotationResult> {
  if (current.keyId === next.keyId)
    throw new Error('la nouvelle clé est identique à la clé actuelle');
  return handle.db.transaction(async (tx) => {
    const result: RotationResult = { credentials: 0, totp: 0 };
    const creds = await tx.select().from(schema.credentials).for('update');
    for (const row of creds) {
      if (row.keyId === next.keyId) continue;
      const plain = current.decrypt(row.userId, CONTEXTS.credentials, row.secret);
      await tx
        .update(schema.credentials)
        .set({ secret: next.encrypt(row.userId, CONTEXTS.credentials, plain), keyId: next.keyId })
        .where(eq(schema.credentials.userId, row.userId));
      result.credentials += 1;
    }
    const totps = await tx.select().from(schema.totp).for('update');
    for (const row of totps) {
      if (row.keyId === next.keyId) continue;
      const plain = current.decrypt(row.userId, CONTEXTS.totp, row.secret);
      await tx
        .update(schema.totp)
        .set({ secret: next.encrypt(row.userId, CONTEXTS.totp, plain), keyId: next.keyId })
        .where(eq(schema.totp.userId, row.userId));
      result.totp += 1;
    }
    return result;
  });
}
