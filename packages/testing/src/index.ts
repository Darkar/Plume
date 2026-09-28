import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

// Conteneurs de test. Aucun test ne touche un vrai serveur de messagerie.
export const IMAGES = {
  postgres: process.env.PLUME_TEST_POSTGRES_IMAGE ?? 'postgres:16-alpine',
  redis: process.env.PLUME_TEST_REDIS_IMAGE ?? 'redis:7-alpine',
  greenmail: process.env.PLUME_TEST_GREENMAIL_IMAGE ?? 'greenmail/standalone:2.1.5',
};

export async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(IMAGES.postgres)
    .withDatabase('plume')
    .withUsername('plume')
    .withPassword('plume-test')
    .start();
}

export async function startRedis(): Promise<StartedRedisContainer> {
  return new RedisContainer(IMAGES.redis).start();
}

export interface GreenMailUser {
  email: string;
  password: string;
}

export interface StartedGreenMail {
  container: StartedTestContainer;
  host: string;
  imapsPort: number;
  imapPort: number;
  smtpPort: number;
  smtpsPort: number;
  stop(): Promise<void>;
}

/**
 * GreenMail : serveur IMAP/SMTP de test. Les identifiants de connexion sont les adresses
 * complètes. IMAPS/SMTPS utilisent un certificat auto-signé.
 */
export async function startGreenMail(users: GreenMailUser[]): Promise<StartedGreenMail> {
  // Format GreenMail : « partie_locale:mot_de_passe@domaine ».
  const userSpec = users
    .map((u) => {
      const [local, domain] = u.email.split('@');
      return `${local}:${u.password}@${domain}`;
    })
    .join(',');
  const container = await new GenericContainer(IMAGES.greenmail)
    .withEnvironment({
      GREENMAIL_OPTS: [
        '-Dgreenmail.setup.test.all',
        '-Dgreenmail.hostname=0.0.0.0',
        '-Dgreenmail.users.login=email',
        `-Dgreenmail.users=${userSpec}`,
        '-Dgreenmail.verbose=false',
      ].join(' '),
    })
    .withExposedPorts(3025, 3143, 3465, 3993)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(120_000)
    .start();
  return {
    container,
    host: container.getHost(),
    imapPort: container.getMappedPort(3143),
    imapsPort: container.getMappedPort(3993),
    smtpPort: container.getMappedPort(3025),
    smtpsPort: container.getMappedPort(3465),
    stop: async () => {
      await container.stop();
    },
  };
}

export interface SeedMessage {
  from?: string;
  to?: string;
  subject?: string;
  html?: string;
  text?: string;
  date?: Date;
  attachments?: {
    filename: string;
    content: string | Buffer;
    contentType?: string;
    cid?: string;
  }[];
  headers?: Record<string, string>;
  /** Source brute RFC 822 (prioritaire sur les autres champs). */
  raw?: string | Buffer;
}

/** Construit un message MIME brut avec le compositeur de Nodemailer. */
export async function buildMessage(message: SeedMessage): Promise<Buffer> {
  if (message.raw) return Buffer.from(message.raw);
  const { default: MailComposer } = await import('nodemailer/lib/mail-composer/index.js');
  const composer = new MailComposer({
    from: message.from ?? 'Expéditeur <expediteur@exemple.fr>',
    to: message.to ?? 'sacha@exemple.com',
    subject: message.subject ?? 'Sans objet',
    html: message.html,
    text: message.text,
    date: message.date ?? new Date(),
    attachments: message.attachments,
    headers: message.headers,
  });
  return composer.compile().build();
}

/** Dépose des messages dans une boîte GreenMail par IMAP APPEND. */
export async function seedMailbox(
  gm: StartedGreenMail,
  user: GreenMailUser,
  messages: (SeedMessage & { folder?: string; flags?: string[] })[],
): Promise<void> {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: gm.host,
    port: gm.imapsPort,
    secure: true,
    tls: { rejectUnauthorized: false },
    auth: { user: user.email, pass: user.password },
    logger: false,
  });
  await client.connect();
  try {
    for (const message of messages) {
      const folder = message.folder ?? 'INBOX';
      if (folder !== 'INBOX') await client.mailboxCreate(folder).catch(() => undefined);
      await client.append(folder, await buildMessage(message), message.flags ?? []);
    }
  } finally {
    await client.logout();
  }
}
