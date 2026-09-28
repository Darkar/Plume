import type { StoredRule } from '@plume/db';
import { fetchFacts } from '@plume/mail';
import {
  ALLOWED_HEADERS,
  checkRule,
  evaluateRules,
  ruleSchema,
  rulesFileSchema,
  type Rule,
  type RuleIssue,
} from '@plume/rules';
import type { ApplyExistingJob } from '@plume/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { encodeMessageId } from '../lib/ids.js';
import { badRequest, HttpError, notFound } from '../lib/http.js';
import { requireSession } from '../plugins/session.js';
import type { SessionData } from '../services/sessions.js';
import { mapMailError } from './mail.js';

const DRY_RUN_SIZE = 200;
const idParam = z.strictObject({ id: z.string().uuid() });
export const reorderBody = z.strictObject({ ids: z.array(z.string().uuid()).max(1000) });
export const importBody = rulesFileSchema.extend({
  mode: z.enum(['append', 'replace']).default('append'),
});
const jobParam = z.strictObject({
  jobId: z.string().regex(/^apply-[0-9a-f-]{36}-[0-9a-f-]{36}-\d+$/),
});

function view(stored: StoredRule) {
  return { id: stored.id, position: stored.position, ...stored.rule, stats: stored.stats };
}

class InvalidRule extends HttpError {
  constructor(issues: unknown) {
    super(400, 'invalid_rule', { issues });
  }
}

export async function rulesRoutes(app: FastifyInstance) {
  const services = app.services;
  const auth = { preHandler: requireSession(['full']) };

  const policy = () => {
    const forward = services.config().rules.forward;
    return { forwardEnabled: forward.enabled, forwardDomains: forward.allowed_destination_domains };
  };

  /** Valide une règle : schéma, puis politique (expressions RE2, transferts autorisés). */
  function validate(input: unknown): Rule {
    const parsed = ruleSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidRule(
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
      );
    }
    const issues: RuleIssue[] = checkRule(parsed.data, policy());
    if (issues.length > 0) throw new InvalidRule(issues);
    return parsed.data;
  }

  function ruleId(request: FastifyRequest): string {
    const parsed = idParam.safeParse(request.params);
    if (!parsed.success) throw notFound();
    return parsed.data.id;
  }

  const ensureEnabled = () => {
    if (!services.config().rules.enabled) throw new HttpError(403, 'rules_disabled');
  };

  app.get('/rules', auth, async (request) => {
    const session = request.session as SessionData;
    const config = services.config().rules;
    return {
      rules: (await services.rules.list(session.userId)).map(view),
      limits: {
        enabled: config.enabled,
        maxRules: config.max_rules_per_user,
        forward: {
          enabled: config.forward.enabled,
          domains: config.forward.allowed_destination_domains,
        },
        allowedHeaders: ALLOWED_HEADERS,
      },
    };
  });

  app.post('/rules', auth, async (request, reply) => {
    ensureEnabled();
    const session = request.session as SessionData;
    const rule = validate(request.body);
    if (
      (await services.rules.count(session.userId)) >= services.config().rules.max_rules_per_user
    ) {
      throw new HttpError(409, 'too_many_rules');
    }
    const stored = await services.rules.create(session.userId, rule);
    await services.rulesChanged(session.userId);
    await services.audit.record({
      event: 'rule_created',
      userId: session.userId,
      ip: request.ip,
      metadata: { ruleId: stored.id },
    });
    return reply.status(201).send(view(stored));
  });

  app.patch('/rules/:id', auth, async (request) => {
    ensureEnabled();
    const session = request.session as SessionData;
    const id = ruleId(request);
    const current = await services.rules.get(session.userId, id);
    if (!current) throw notFound();
    const patch = request.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw badRequest();
    const rule = validate({ ...current.rule, ...patch });
    const stored = await services.rules.update(session.userId, id, rule);
    if (!stored) throw notFound();
    await services.rulesChanged(session.userId);
    await services.audit.record({
      event: 'rule_updated',
      userId: session.userId,
      ip: request.ip,
      metadata: { ruleId: id },
    });
    return view(stored);
  });

  app.delete('/rules/:id', auth, async (request, reply) => {
    const session = request.session as SessionData;
    const id = ruleId(request);
    if (!(await services.rules.remove(session.userId, id))) throw notFound();
    await services.rulesChanged(session.userId);
    await services.audit.record({
      event: 'rule_deleted',
      userId: session.userId,
      ip: request.ip,
      metadata: { ruleId: id },
    });
    return reply.status(204).send();
  });

  app.post('/rules/reorder', auth, async (request) => {
    const session = request.session as SessionData;
    const parsed = reorderBody.safeParse(request.body);
    if (!parsed.success) throw badRequest();
    if (!(await services.rules.reorder(session.userId, parsed.data.ids)))
      throw badRequest('invalid_order');
    await services.rulesChanged(session.userId);
    await services.audit.record({
      event: 'rules_reordered',
      userId: session.userId,
      ip: request.ip,
    });
    return { rules: (await services.rules.list(session.userId)).map(view) };
  });

  /** Exécution à blanc sur les 200 derniers messages : aucune modification. */
  async function dryRun(userId: string, rule: Rule) {
    try {
      const client = await services.mail.pool.acquire(userId);
      const lock = await client.getMailboxLock('INBOX');
      let uids: number[];
      let uidValidity: string;
      try {
        uids = ((await client.search({ all: true }, { uid: true })) || [])
          .sort((a, b) => b - a)
          .slice(0, DRY_RUN_SIZE);
        uidValidity = String(client.mailbox ? client.mailbox.uidValidity : 0);
      } finally {
        lock.release();
      }
      const withBody = rule.conditions.some((c) => c.field === 'body_text');
      const messages = await fetchFacts(client, 'INBOX', uids, { withBody });
      const enabled = { ...rule, enabled: true, stop_processing: false };
      const matches = messages
        .filter((m) => evaluateRules([enabled], m.facts).matched.length > 0)
        .sort((a, b) => b.uid - a.uid)
        .map((m) => ({
          id: encodeMessageId({ folder: 'INBOX', uidValidity, uid: m.uid }),
          subject: m.facts.subject,
          from: m.facts.from,
        }));
      return { tested: messages.length, matches };
    } catch (error) {
      return mapMailError(services, userId, error);
    }
  }

  app.post('/rules/test', auth, async (request) => {
    const session = request.session as SessionData;
    return dryRun(session.userId, validate(request.body));
  });

  app.post('/rules/:id/test', auth, async (request) => {
    const session = request.session as SessionData;
    const stored = await services.rules.get(session.userId, ruleId(request));
    if (!stored) throw notFound();
    return dryRun(session.userId, stored.rule);
  });

  /** Application aux messages existants : tâche de fond, progression consultable. */
  app.post('/rules/:id/apply', auth, async (request, reply) => {
    ensureEnabled();
    const session = request.session as SessionData;
    const id = ruleId(request);
    if (!(await services.rules.get(session.userId, id))) throw notFound();
    if (await services.limiter.hit('rules-apply', session.userId, 10, 60 * 60_000)) {
      throw new HttpError(429, 'rate_limited');
    }
    // BullMQ interdit « : » dans les identifiants personnalisés.
    const jobId = `apply-${session.userId}-${id}-${services.now()}`;
    await services.rulesQueue.add(
      'apply-existing',
      { userId: session.userId, ruleId: id, mailbox: 'INBOX' } satisfies ApplyExistingJob,
      {
        jobId,
        removeOnComplete: { age: 24 * 3600 },
        removeOnFail: { age: 24 * 3600 },
      },
    );
    return reply.status(202).send({ jobId });
  });

  app.get('/rules/jobs/:jobId', auth, async (request) => {
    const session = request.session as SessionData;
    const parsed = jobParam.safeParse(request.params);
    if (!parsed.success) throw notFound();
    const job = await services.rulesQueue.getJob(parsed.data.jobId);
    // Contrôle d'accès : la tâche doit appartenir à l'utilisateur connecté.
    if (!job || (job.data as ApplyExistingJob).userId !== session.userId) throw notFound();
    const state = await job.getState();
    return {
      state,
      progress: typeof job.progress === 'object' ? job.progress : null,
      result: state === 'completed' ? job.returnvalue : null,
    };
  });

  app.get('/rules/export', auth, async (request, reply) => {
    const session = request.session as SessionData;
    const rules = (await services.rules.list(session.userId)).map((s) => s.rule);
    return reply
      .header('Content-Disposition', 'attachment; filename="plume-regles.json"')
      .send({ version: 1, rules });
  });

  app.post('/rules/import', auth, async (request) => {
    ensureEnabled();
    const session = request.session as SessionData;
    const parsed = importBody.safeParse(request.body);
    if (!parsed.success) {
      throw new InvalidRule(
        parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), code: i.code })),
      );
    }
    const rules = parsed.data.rules.map((rule, index) => {
      const issues = checkRule(rule, policy());
      if (issues.length > 0) throw new InvalidRule([{ index, issues }]);
      return rule;
    });
    const existing =
      parsed.data.mode === 'replace' ? 0 : await services.rules.count(session.userId);
    if (existing + rules.length > services.config().rules.max_rules_per_user) {
      throw new HttpError(409, 'too_many_rules');
    }
    const imported = await services.rules.importRules(session.userId, rules, parsed.data.mode);
    await services.rulesChanged(session.userId);
    await services.audit.record({
      event: 'rules_imported',
      userId: session.userId,
      ip: request.ip,
      metadata: { count: imported },
    });
    return { imported };
  });
}
