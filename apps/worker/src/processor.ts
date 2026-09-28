import type { PlumeConfig } from '@plume/config';
import type { RulesRepository, StoredRule } from '@plume/db';
import {
  applyActions,
  buildMime,
  fetchFacts,
  headerSafe,
  ImapFlow,
  imapOptions,
  rulesNeedBody,
  sendRaw,
  type MessageEnvelopeFacts,
  type PoolCredentials,
  type SmtpCredentials,
} from '@plume/mail';
import {
  canAutoReply,
  canForward,
  checkRule,
  evaluateRules,
  type Action,
  type Rule,
} from '@plume/rules';
import type { Logger } from 'pino';

export interface AccountInfo {
  email: string;
  imap: PoolCredentials;
  smtp: SmtpCredentials;
}

export interface ProcessorDeps {
  config: () => PlumeConfig;
  logger: Logger;
  repo: RulesRepository;
  /** Identifiants d'un compte (null si suspendu, domaine retiré ou identifiants absents). */
  account: (userId: string) => Promise<AccountInfo | null>;
  /** Envoi SMTP (injectable pour les tests). */
  send?: typeof sendRaw;
}

const BATCH_SIZE = 50;
/** Nombre maximal de nouveaux messages traités par passage (le reste au passage suivant). */
const MAX_PER_RUN = 500;

export class AccountUnavailable extends Error {
  constructor() {
    super('account_unavailable');
  }
}

/** Traitement des règles pour un utilisateur (nouveaux messages, application rétroactive). */
export class RuleProcessor {
  private readonly send: typeof sendRaw;

  constructor(private readonly deps: ProcessorDeps) {
    this.send = deps.send ?? sendRaw;
  }

  private async connect(account: AccountInfo): Promise<ImapFlow> {
    const client = new ImapFlow(
      imapOptions(account.imap.target, { user: account.imap.user, pass: account.imap.pass }),
    );
    client.on('error', () => undefined);
    await client.connect();
    return client;
  }

  /** Règles actives, revalidées contre la politique courante (transferts…). */
  private activeRules(stored: StoredRule[]): { stored: StoredRule; rule: Rule }[] {
    const forward = this.deps.config().rules.forward;
    const policy = {
      forwardEnabled: forward.enabled,
      forwardDomains: forward.allowed_destination_domains,
    };
    return stored
      .filter((s) => s.rule.enabled)
      .map((s) => {
        // Une action de transfert devenue interdite (configuration modifiée) est retirée.
        const issues = checkRule(s.rule, policy);
        const blocked = new Set(issues.flatMap((i) => ('actionIndex' in i ? [i.actionIndex] : [])));
        return {
          stored: s,
          rule: { ...s.rule, actions: s.rule.actions.filter((_, i) => !blocked.has(i)) },
        };
      });
  }

  private sideEffects(
    userId: string,
    account: AccountInfo,
    message: MessageEnvelopeFacts,
    client: ImapFlow,
    mailbox: string,
  ) {
    const log = this.deps.logger;
    return {
      forward: async (to: string) => {
        if (!canForward(message.facts, message.rawHeaders)) throw new Error('forward_loop');
        const lock = await client.getMailboxLock(mailbox, { readOnly: true });
        let source: Buffer;
        try {
          const max = this.deps.config().security.max_attachment_size;
          const { content } = await client.download(String(message.uid), undefined, {
            uid: true,
            maxBytes: max,
          });
          const chunks: Buffer[] = [];
          for await (const chunk of content) chunks.push(chunk as Buffer);
          source = Buffer.concat(chunks);
        } finally {
          lock.release();
        }
        const raw = await buildMime({
          from: { name: '', address: account.email },
          to: [{ name: '', address: to }],
          cc: [],
          bcc: [],
          subject: headerSafe(`Fwd: ${message.facts.subject}`, 500),
          html: '<p>Message transféré automatiquement par une règle Plume.</p>',
          attachments: [
            { filename: 'message.eml', contentType: 'message/rfc822', content: source },
          ],
          automatic: 'forwarded',
        });
        await this.send(account.smtp, { from: account.email, to: [to] }, raw);
        log.info({ userId, rule: 'forward' }, 'message transféré par une règle');
      },
      autoReply: async (action: Extract<Action, { type: 'auto_reply' }>) => {
        const sender = message.facts.from[0]?.address;
        if (!sender || !canAutoReply(message.facts, account.email))
          throw new Error('auto_reply_not_allowed');
        if (!(await this.deps.repo.claimAutoReply(userId, sender)))
          throw new Error('auto_reply_rate_limited');
        const raw = await buildMime({
          from: { name: '', address: account.email },
          to: [{ name: '', address: sender }],
          cc: [],
          bcc: [],
          subject: action.subject || `Re: ${message.facts.subject}`,
          html: action.body
            .split(/\r?\n/)
            .map((line) => `<p>${line.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</p>`)
            .join(''),
          inReplyTo: message.messageId ?? undefined,
          attachments: [],
          automatic: 'auto-replied',
        });
        // Enveloppe à expéditeur nul (RFC 3834) : une éventuelle erreur ne relance pas de boucle.
        await this.send(account.smtp, { from: account.email, to: [sender] }, raw);
      },
    };
  }

  /**
   * Traite les messages arrivés depuis le dernier passage. Au premier passage, le curseur est
   * placé à la fin de la boîte : les messages existants ne sont pas traités (voir
   * « Appliquer aux messages existants »).
   */
  async processNew(
    userId: string,
    mailbox = 'INBOX',
  ): Promise<{ processed: number; matched: number }> {
    if (!this.deps.config().rules.enabled) return { processed: 0, matched: 0 };
    const stored = await this.deps.repo.list(userId);
    const rules = this.activeRules(stored);
    if (rules.length === 0) return { processed: 0, matched: 0 };
    const account = await this.deps.account(userId);
    if (!account) throw new AccountUnavailable();

    const client = await this.connect(account);
    let processed = 0;
    let matched = 0;
    try {
      const status = await client.status(mailbox, { uidNext: true, uidValidity: true });
      const uidValidity = Number(status.uidValidity ?? 0);
      const lastKnown = (status.uidNext ?? 1) - 1;
      const cursor = await this.deps.repo.getCursor(userId, mailbox);
      if (!cursor || cursor.uidValidity !== uidValidity) {
        await this.deps.repo.setCursor(userId, mailbox, uidValidity, lastKnown);
        return { processed: 0, matched: 0 };
      }
      if (lastKnown <= cursor.lastUid) return { processed: 0, matched: 0 };

      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      let uids: number[];
      try {
        uids = ((await client.search({ uid: `${cursor.lastUid + 1}:*` }, { uid: true })) || [])
          .filter((uid) => uid > cursor.lastUid)
          .sort((a, b) => a - b)
          .slice(0, MAX_PER_RUN);
      } finally {
        lock.release();
      }

      const withBody = rulesNeedBody(rules.map((r) => r.rule));
      let highest = cursor.lastUid;
      for (let i = 0; i < uids.length; i += BATCH_SIZE) {
        const batch = uids.slice(i, i + BATCH_SIZE);
        const messages = await fetchFacts(client, mailbox, batch, { withBody });
        for (const message of messages.sort((a, b) => a.uid - b.uid)) {
          highest = Math.max(highest, message.uid);
          // Idempotence : réservé AVANT d'agir (au plus une exécution, jamais deux transferts).
          if (!(await this.deps.repo.claimMessage(userId, mailbox, uidValidity, message.uid)))
            continue;
          // Message déjà traité sous un autre UID (remis dans la boîte après un report ou
          // l'annulation d'un archivage) : aucune règle n'est rejouée.
          if (
            message.messageId &&
            !(await this.deps.repo.claimMessageId(userId, message.messageId))
          ) {
            continue;
          }
          processed += 1;
          const outcome = evaluateRules(
            rules.map((r) => r.rule),
            message.facts,
          );
          for (const error of outcome.errors) {
            await this.deps.repo.recordError(userId, rules[error.index]!.stored.id, error.code);
          }
          if (outcome.actions.length === 0) continue;
          matched += 1;
          const ref = { folder: mailbox, uidValidity: String(uidValidity), uid: message.uid };
          const result = await applyActions(
            client,
            ref,
            outcome.actions,
            this.sideEffects(userId, account, message, client, mailbox),
          );
          await this.deps.repo.recordRun(
            userId,
            outcome.matched.map((index) => rules[index]!.stored.id),
            1,
          );
          for (const skipped of result.skipped) {
            const index = outcome.matched[0];
            if (index !== undefined)
              await this.deps.repo.recordError(userId, rules[index]!.stored.id, skipped.reason);
          }
        }
        await this.deps.repo.setCursor(userId, mailbox, uidValidity, highest);
      }
      await this.deps.repo.setCursor(
        userId,
        mailbox,
        uidValidity,
        Math.max(highest, uids.at(-1) ?? highest),
      );
      return { processed, matched };
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  /**
   * Applique une règle aux messages déjà présents. Les transferts et réponses automatiques ne sont
   * jamais exécutés rétroactivement (risque d'envoi massif).
   */
  async applyExisting(
    userId: string,
    ruleId: string,
    mailbox: string,
    onProgress: (done: number, total: number) => Promise<void>,
  ): Promise<{ total: number; matched: number }> {
    const stored = await this.deps.repo.get(userId, ruleId);
    if (!stored) throw new Error('rule_not_found');
    const [active] = this.activeRules([{ ...stored, rule: { ...stored.rule, enabled: true } }]);
    const rule: Rule = {
      ...active!.rule,
      stop_processing: false,
      actions: active!.rule.actions.filter((a) => a.type !== 'forward' && a.type !== 'auto_reply'),
    };
    if (rule.actions.length === 0) return { total: 0, matched: 0 };
    const account = await this.deps.account(userId);
    if (!account) throw new AccountUnavailable();
    const client = await this.connect(account);
    try {
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      let uids: number[];
      let uidValidity: string;
      try {
        uids = ((await client.search({ all: true }, { uid: true })) || []).sort((a, b) => b - a);
        uidValidity = String(client.mailbox ? client.mailbox.uidValidity : 0);
      } finally {
        lock.release();
      }
      const withBody = rulesNeedBody([rule]);
      let matched = 0;
      for (let i = 0; i < uids.length; i += BATCH_SIZE) {
        const batch = uids.slice(i, i + BATCH_SIZE);
        const messages = await fetchFacts(client, mailbox, batch, { withBody });
        for (const message of messages) {
          const outcome = evaluateRules([rule], message.facts);
          if (outcome.actions.length === 0) continue;
          matched += 1;
          await applyActions(
            client,
            { folder: mailbox, uidValidity, uid: message.uid },
            outcome.actions,
            {
              forward: async () => undefined,
              autoReply: async () => undefined,
            },
          );
        }
        await onProgress(Math.min(i + batch.length, uids.length), uids.length);
      }
      await this.deps.repo.recordRun(userId, [ruleId], matched);
      return { total: uids.length, matched };
    } finally {
      await client.logout().catch(() => client.close());
    }
  }
}
