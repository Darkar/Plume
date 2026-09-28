import { ImapFlow } from 'imapflow';
import { seedMailbox, startGreenMail, type StartedGreenMail } from '@plume/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imapOptions } from '../src/imap.js';
import {
  downloadPart,
  getMessage,
  listFolders,
  listMessages,
  MailboxError,
} from '../src/mailbox.js';
import { ImapAuthError, ImapPool } from '../src/pool.js';
import type { ServerTarget } from '../src/server.js';

const USER = { email: 'sacha@exemple.com', password: 'secret' };
let gm: StartedGreenMail;
let target: ServerTarget;
let client: ImapFlow;

beforeAll(async () => {
  gm = await startGreenMail([USER]);
  target = {
    host: gm.host,
    port: gm.imapsPort,
    security: 'tls',
    tls: { reject_unauthorized: false, min_version: 'TLSv1.2' },
  };
  const base = new Date('2026-09-01T10:00:00Z').getTime();
  await seedMailbox(gm, USER, [
    ...Array.from({ length: 25 }, (_, i) => ({
      subject: `Message ${i + 1}`,
      text: `Corps ${i + 1}`,
      date: new Date(base + i * 60_000),
      flags: i % 3 === 0 ? ['\\Seen'] : [],
    })),
    {
      subject: 'Facture septembre',
      from: 'Nimbus <factures@nimbus.example>',
      html: '<p>Bonjour <img src="cid:logo@nimbus"></p><script>window.__xss=1</script>',
      attachments: [
        {
          filename: 'facture.pdf',
          content: Buffer.from('%PDF-1.4 test'),
          contentType: 'application/pdf',
        },
        {
          filename: 'logo.png',
          content: Buffer.from('89504e47', 'hex'),
          contentType: 'image/png',
          cid: 'logo@nimbus',
        },
      ],
      flags: ['\\Flagged', 'Factures'],
    },
    { folder: 'Archives', subject: 'Archivé', text: 'x' },
  ]);
  client = new ImapFlow(imapOptions(target, { user: USER.email, pass: USER.password }));
  await client.connect();
});

afterAll(async () => {
  await client?.logout().catch(() => undefined);
  await gm?.stop();
});

describe('dossiers', () => {
  it('liste les dossiers avec compteurs', async () => {
    const folders = await listFolders(client);
    const inbox = folders.find((f) => f.path === 'INBOX');
    expect(inbox).toMatchObject({ specialUse: '\\Inbox', total: 26 });
    expect(inbox?.unseen).toBe(26 - 9);
    expect(folders.some((f) => f.path === 'Archives')).toBe(true);
  });
});

describe('liste des messages', () => {
  it('pagine par curseur, du plus récent au plus ancien', async () => {
    const page1 = await listMessages(client, { folder: 'INBOX', filter: 'all', limit: 10 });
    expect(page1.total).toBe(26);
    expect(page1.messages).toHaveLength(10);
    expect(page1.messages[0]?.subject).toBe('Facture septembre');
    expect(page1.nextBeforeUid).not.toBeNull();
    const page2 = await listMessages(client, {
      folder: 'INBOX',
      filter: 'all',
      limit: 10,
      beforeUid: page1.nextBeforeUid as number,
      uidValidity: page1.uidValidity,
    });
    const page3 = await listMessages(client, {
      folder: 'INBOX',
      filter: 'all',
      limit: 10,
      beforeUid: page2.nextBeforeUid as number,
      uidValidity: page1.uidValidity,
    });
    expect(page3.messages).toHaveLength(6);
    expect(page3.nextBeforeUid).toBeNull();
    const all = [...page1.messages, ...page2.messages, ...page3.messages].map((m) => m.ref.uid);
    expect(new Set(all).size).toBe(26);
  });

  it('filtre non lus, favoris et pièces jointes', async () => {
    const unseen = await listMessages(client, { folder: 'INBOX', filter: 'unseen', limit: 50 });
    expect(unseen.messages.every((m) => !m.seen)).toBe(true);
    const flagged = await listMessages(client, { folder: 'INBOX', filter: 'flagged', limit: 50 });
    expect(flagged.messages.map((m) => m.subject)).toEqual(['Facture septembre']);
    expect(flagged.messages[0]?.keywords).toEqual(['Factures']);
    const withAttachments = await listMessages(client, {
      folder: 'INBOX',
      filter: 'attachments',
      limit: 50,
    });
    expect(withAttachments.messages.map((m) => m.subject)).toEqual(['Facture septembre']);
  });

  it('recherche (IMAP SEARCH)', async () => {
    const result = await listMessages(client, {
      folder: 'INBOX',
      filter: 'all',
      query: 'facture',
      limit: 50,
    });
    expect(result.messages.map((m) => m.subject)).toEqual(['Facture septembre']);
  });

  it('refuse un curseur d’une autre UIDVALIDITY', async () => {
    await expect(
      listMessages(client, { folder: 'INBOX', filter: 'all', limit: 5, uidValidity: '1' }),
    ).rejects.toThrow(new MailboxError('stale_cursor'));
  });

  it('signale un dossier inexistant', async () => {
    await expect(
      listMessages(client, { folder: 'Inexistant', filter: 'all', limit: 5 }),
    ).rejects.toThrow(MailboxError);
  });
});

describe('robustesse', () => {
  it('ne masque pas un message dont le serveur renvoie une ENVELOPE inexploitable', async () => {
    const subject = 'Citation <IMG SRC="javascript:x"> fin';
    await seedMailbox(gm, USER, [
      { folder: 'Robustesse', subject, from: '"Nom <b>" <a@exemple.fr>', text: 'x' },
    ]);
    const list = await listMessages(client, { folder: 'Robustesse', filter: 'all', limit: 10 });
    expect(list.total).toBe(1);
    expect(list.messages[0]).toMatchObject({ subject });
    expect(list.messages[0]?.from[0]?.address).toBe('a@exemple.fr');
    const detail = await getMessage(client, list.messages[0]!.ref, {
      markSeen: false,
      maxBodyBytes: 1000,
    });
    expect(detail.detail.subject).toBe(subject);
  });
});

describe('message', () => {
  it('charge le corps HTML, les pièces jointes, et marque comme lu', async () => {
    const list = await listMessages(client, { folder: 'INBOX', filter: 'flagged', limit: 1 });
    const ref = list.messages[0]!.ref;
    const content = await getMessage(client, ref, { markSeen: true, maxBodyBytes: 1024 * 1024 });
    expect(content.html).toContain('cid:logo@nimbus');
    expect(content.detail.from).toEqual([{ name: 'Nimbus', address: 'factures@nimbus.example' }]);
    const byName = [...content.detail.attachments].sort((a, b) =>
      a.filename.localeCompare(b.filename),
    );
    expect(byName.map((a) => [a.filename, a.inline, a.contentId])).toEqual([
      ['facture.pdf', false, null],
      ['logo.png', true, 'logo@nimbus'],
    ]);
    const again = await listMessages(client, { folder: 'INBOX', filter: 'flagged', limit: 1 });
    expect(again.messages[0]?.seen).toBe(true);

    const pdf = byName[0]!;
    const downloaded = await downloadPart(client, ref, pdf.part, 1024 * 1024);
    expect(downloaded.content.toString()).toBe('%PDF-1.4 test');
    await expect(downloadPart(client, ref, '9.9', 1024)).rejects.toThrow(
      new MailboxError('part_not_found'),
    );
  });

  it('refuse une référence dont l’UIDVALIDITY ne correspond pas', async () => {
    await expect(
      getMessage(
        client,
        { folder: 'INBOX', uidValidity: '42', uid: 1 },
        { markSeen: false, maxBodyBytes: 1000 },
      ),
    ).rejects.toThrow(new MailboxError('message_not_found'));
  });

  it('limite la taille du corps', async () => {
    const list = await listMessages(client, { folder: 'INBOX', filter: 'flagged', limit: 1 });
    await expect(
      getMessage(client, list.messages[0]!.ref, { markSeen: false, maxBodyBytes: 10 }),
    ).rejects.toThrow();
  });
});

describe('ImapPool', () => {
  it('réutilise la connexion d’un utilisateur', async () => {
    const pool = new ImapPool(async () => ({ target, user: USER.email, pass: USER.password }));
    const a = await pool.acquire('u1');
    const b = await pool.acquire('u1');
    expect(a).toBe(b);
    expect(pool.size).toBe(1);
    pool.release('u1');
    expect(pool.size).toBe(0);
    await pool.close();
  });

  it('signale un mot de passe devenu invalide', async () => {
    const pool = new ImapPool(async () => ({ target, user: USER.email, pass: 'périmé' }));
    await expect(pool.acquire('u2')).rejects.toThrow(ImapAuthError);
    await pool.close();
  });
});
