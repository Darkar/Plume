import { matchAccount, type PlumeConfig } from '@plume/config';
import type { SecretBox } from '@plume/crypto';
import { IMAP_PASSWORD_CONTEXT, schema, type DbHandle } from '@plume/db';
import { loginFor, serverFor, smtpLoginFor } from '@plume/mail';
import { eq } from 'drizzle-orm';
import type { AccountInfo } from './processor.js';

/**
 * Identifiants d'un compte pour le moteur de règles. Renvoie null si le compte est suspendu, si
 * son domaine n'est plus dans la liste blanche ou si aucun mot de passe n'est enregistré.
 */
export function accountResolver(db: DbHandle['db'], box: SecretBox, config: () => PlumeConfig) {
  return async (userId: string): Promise<AccountInfo | null> => {
    const [row] = await db
      .select({
        email: schema.users.email,
        domain: schema.users.domain,
        suspendedAt: schema.users.suspendedAt,
        secret: schema.credentials.secret,
      })
      .from(schema.users)
      .innerJoin(schema.credentials, eq(schema.credentials.userId, schema.users.id))
      .where(eq(schema.users.id, userId));
    if (!row || row.suspendedAt) return null;
    const domain = matchAccount(config().domains, row.email);
    if (!domain) return null;
    let pass: string;
    try {
      pass = box.decrypt(userId, IMAP_PASSWORD_CONTEXT, row.secret);
    } catch {
      return null;
    }
    let smtp: { user: string; pass: string };
    try {
      const { user, pass: smtpPass } = smtpLoginFor(domain, row.email, pass);
      smtp = { user, pass: smtpPass };
    } catch {
      return null; // Secret du relais SMTP illisible.
    }
    return {
      email: row.email,
      imap: { target: serverFor(domain, 'imap'), user: loginFor(domain, row.email), pass },
      smtp: { target: serverFor(domain, 'smtp'), ...smtp },
    };
  };
}
