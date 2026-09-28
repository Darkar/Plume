import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export interface DbHandle {
  pool: pg.Pool;
  db: NodePgDatabase;
  close(): Promise<void>;
}

export function createDb(url: string, options: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Limite la durée d'une requête pour éviter qu'une requête bloquée n'épuise le pool.
    statement_timeout: 15_000,
    application_name: 'plume',
  });
  // Une connexion inactive coupée côté serveur (redémarrage, bascule) émet une erreur : sans
  // gestionnaire, elle ferait planter le processus. Le pool la remplace à la prochaine requête.
  pool.on('error', () => undefined);
  const db = drizzle(pool);
  return {
    pool,
    db,
    close: () => pool.end(),
  };
}

export async function pingDb(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}
