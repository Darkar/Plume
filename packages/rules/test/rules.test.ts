import { describe, expect, it } from 'vitest';
import {
  canAutoReply,
  canForward,
  checkRule,
  compilePattern,
  domainAllowed,
  evaluateCondition,
  evaluateRule,
  evaluateRules,
  isValidPattern,
  MAX_TEXT_LENGTH,
  ruleSchema,
  rulesFileSchema,
  type MessageFacts,
  type Rule,
  type RuleInput,
} from '../src/index.js';

const facts = (patch: Partial<MessageFacts> = {}): MessageFacts => ({
  from: [{ name: 'Nimbus Facturation', address: 'factures@nimbus.example' }],
  to: [{ name: 'Sacha', address: 'sacha@exemple.com' }],
  cc: [],
  subject: 'Votre FACTURE de septembre',
  bodyText: 'Bonjour, veuillez trouver ci-joint la facture n° 42.',
  attachments: [{ filename: 'facture-042.pdf' }],
  size: 120_000,
  headers: {},
  ...patch,
});

const rule = (input: Partial<RuleInput> & Pick<RuleInput, 'conditions'>): Rule =>
  ruleSchema.parse({ name: 'Règle', actions: [{ type: 'mark_read' }], ...input });

describe('schéma', () => {
  it('accepte l’exemple de la spécification', () => {
    const parsed = ruleSchema.parse({
      name: 'Factures fournisseurs',
      enabled: true,
      match: 'all',
      conditions: [
        { field: 'from', op: 'ends_with', value: '@nimbus.example' },
        { field: 'subject', op: 'contains', value: 'facture' },
        { field: 'has_attachment', op: 'is', value: true },
      ],
      actions: [
        { type: 'add_label', label: 'Factures' },
        { type: 'mark_read' },
        { type: 'move', folder: 'Archives' },
      ],
      stop_processing: true,
    });
    expect(parsed.actions).toHaveLength(3);
  });

  it('applique les valeurs par défaut', () => {
    const parsed = rule({ conditions: [{ field: 'subject', op: 'contains', value: 'x' }] });
    expect(parsed).toMatchObject({ enabled: true, match: 'all', stop_processing: false });
  });

  it.each([
    ['champ inconnu', { conditions: [{ field: 'body_html', op: 'contains', value: 'x' }] }],
    [
      'en-tête non autorisé',
      { conditions: [{ field: 'header:authorization', op: 'contains', value: 'x' }] },
    ],
    ['en-tête mal formé', { conditions: [{ field: 'header:x y', op: 'contains', value: 'x' }] }],
    ['opérateur incompatible', { conditions: [{ field: 'size', op: 'contains', value: 'x' }] }],
    ['taille négative', { conditions: [{ field: 'size', op: 'greater_than', value: -1 }] }],
    ['booléen attendu', { conditions: [{ field: 'has_attachment', op: 'is', value: 'oui' }] }],
    ['valeur vide', { conditions: [{ field: 'subject', op: 'contains', value: '   ' }] }],
    [
      'expression trop longue',
      { conditions: [{ field: 'subject', op: 'matches', value: 'a'.repeat(257) }] },
    ],
    ['aucune condition', { conditions: [] }],
    [
      'trop de conditions',
      { conditions: Array(21).fill({ field: 'subject', op: 'contains', value: 'x' }) },
    ],
    [
      'action inconnue',
      {
        conditions: [{ field: 'subject', op: 'contains', value: 'x' }],
        actions: [{ type: 'exec', cmd: 'rm' }],
      },
    ],
    [
      'libellé invalide',
      {
        conditions: [{ field: 'subject', op: 'contains', value: 'x' }],
        actions: [{ type: 'add_label', label: 'a b' }],
      },
    ],
    ['champ en trop', { conditions: [{ field: 'subject', op: 'contains', value: 'x', extra: 1 }] }],
    [
      'réponse automatique vide',
      {
        conditions: [{ field: 'subject', op: 'contains', value: 'x' }],
        actions: [{ type: 'auto_reply', body: '' }],
      },
    ],
  ])('refuse : %s', (_name, input) => {
    expect(ruleSchema.safeParse({ name: 'r', actions: [{ type: 'star' }], ...input }).success).toBe(
      false,
    );
  });

  it('valide un fichier d’import', () => {
    expect(rulesFileSchema.safeParse({ version: 1, rules: [] }).success).toBe(true);
    expect(rulesFileSchema.safeParse({ version: 2, rules: [] }).success).toBe(false);
    expect(rulesFileSchema.safeParse({ rules: [] }).success).toBe(false);
  });

  it('normalise le nom des en-têtes', () => {
    const parsed = rule({
      conditions: [{ field: 'header:X-Spam-Flag', op: 'equals', value: 'YES' }],
    });
    expect(parsed.conditions[0]?.field).toBe('header:x-spam-flag');
  });
});

describe('conditions', () => {
  const cases: [string, RuleInput['conditions'][number], boolean][] = [
    ['from ends_with', { field: 'from', op: 'ends_with', value: '@nimbus.example' }, true],
    ['from contains nom', { field: 'from', op: 'contains', value: 'facturation' }, true],
    [
      'from equals adresse',
      { field: 'from', op: 'equals', value: 'FACTURES@nimbus.example' },
      true,
    ],
    ['from starts_with', { field: 'from', op: 'starts_with', value: 'nimbus' }, true],
    ['from not_contains', { field: 'from', op: 'not_contains', value: 'nimbus' }, false],
    ['to contains', { field: 'to', op: 'contains', value: 'sacha@' }, true],
    ['cc vide', { field: 'cc', op: 'contains', value: 'x' }, false],
    ['cc not_contains vide', { field: 'cc', op: 'not_contains', value: 'x' }, true],
    ['sujet insensible à la casse', { field: 'subject', op: 'contains', value: 'facture' }, true],
    ['sujet equals', { field: 'subject', op: 'equals', value: 'votre facture de septembre' }, true],
    ['corps contains', { field: 'body_text', op: 'contains', value: 'n° 42' }, true],
    ['pièce jointe', { field: 'attachment_name', op: 'ends_with', value: '.pdf' }, true],
    ['avec pièce jointe', { field: 'has_attachment', op: 'is', value: true }, true],
    ['sans pièce jointe', { field: 'has_attachment', op: 'is', value: false }, false],
    ['taille >', { field: 'size', op: 'greater_than', value: 100_000 }, true],
    ['taille <', { field: 'size', op: 'less_than', value: 100_000 }, false],
    ['regex', { field: 'subject', op: 'matches', value: '^votre\\s+facture' }, true],
    ['regex unicode', { field: 'body_text', op: 'matches', value: 'n°\\s*\\d+' }, true],
    ['list_id absent', { field: 'list_id', op: 'contains', value: 'x' }, false],
    ['en-tête absent', { field: 'header:x-spam-flag', op: 'equals', value: 'yes' }, false],
  ];
  it.each(cases)('%s', (_name, condition, expected) => {
    const parsed = rule({ conditions: [condition] }).conditions[0]!;
    expect(evaluateCondition(parsed, facts())).toBe(expected);
  });

  it('lit les en-têtes autorisés et List-Id', () => {
    const f = facts({ headers: { 'x-spam-flag': ['YES'], 'list-id': ['<annonces.exemple.fr>'] } });
    expect(
      evaluateCondition(
        rule({ conditions: [{ field: 'header:x-spam-flag', op: 'equals', value: 'yes' }] })
          .conditions[0]!,
        f,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        rule({ conditions: [{ field: 'list_id', op: 'contains', value: 'annonces' }] })
          .conditions[0]!,
        f,
      ),
    ).toBe(true);
  });

  it('normalise l’Unicode (NFKC)', () => {
    const f = facts({ subject: 'ＦＡＣＴＵＲＥ' });
    expect(
      evaluateCondition(
        rule({ conditions: [{ field: 'subject', op: 'contains', value: 'facture' }] })
          .conditions[0]!,
        f,
      ),
    ).toBe(true);
  });
});

describe('ReDoS', () => {
  it('une expression catastrophique pour un moteur à retour arrière s’exécute en temps linéaire', () => {
    const catastrophic = rule({
      conditions: [{ field: 'body_text', op: 'matches', value: '^(a+)+$' }],
    });
    const f = facts({ bodyText: `${'a'.repeat(50_000)}!` });
    const started = performance.now();
    expect(evaluateRule(catastrophic, f)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it.each(['(a|a)*b', '(.*a){20}', '(x+x+)+y', '([a-z]+)*$'])('%s reste rapide', (pattern) => {
    const r = rule({ conditions: [{ field: 'body_text', op: 'matches', value: pattern }] });
    const started = performance.now();
    evaluateRule(r, facts({ bodyText: 'a'.repeat(30_000) }));
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('refuse les constructions non linéaires (rétroréférences, assertions)', () => {
    expect(isValidPattern('(a)\\1')).toBe(false);
    expect(isValidPattern('a(?=b)')).toBe(false);
    expect(isValidPattern('(?<!x)y')).toBe(false);
    expect(isValidPattern('[')).toBe(false);
    expect(isValidPattern('^facture\\s+\\d+$')).toBe(true);
  });

  it('borne la longueur du texte examiné', () => {
    const r = rule({ conditions: [{ field: 'body_text', op: 'contains', value: 'fin' }] });
    expect(evaluateRule(r, facts({ bodyText: `${'x'.repeat(MAX_TEXT_LENGTH)}fin` }))).toBe(false);
  });

  it('met en cache les expressions compilées', () => {
    expect(compilePattern('abc')).toBe(compilePattern('abc'));
  });
});

describe('évaluation de plusieurs règles', () => {
  const invoice = rule({
    name: 'Factures',
    conditions: [
      { field: 'from', op: 'ends_with', value: '@nimbus.example' },
      { field: 'subject', op: 'contains', value: 'facture' },
    ],
    actions: [
      { type: 'add_label', label: 'Factures' },
      { type: 'move', folder: 'Archives' },
    ],
    stop_processing: true,
  });
  const anyRule = rule({
    name: 'Tout',
    match: 'any',
    conditions: [
      { field: 'subject', op: 'contains', value: 'introuvable' },
      { field: 'size', op: 'greater_than', value: 1 },
    ],
    actions: [{ type: 'star' }],
  });

  it('respecte l’ordre et stop_processing', () => {
    const outcome = evaluateRules([invoice, anyRule], facts());
    expect(outcome.matched).toEqual([0]);
    expect(outcome.actions.map((a) => a.type)).toEqual(['add_label', 'move']);
  });

  it('cumule les actions sans stop_processing', () => {
    const outcome = evaluateRules([{ ...invoice, stop_processing: false }, anyRule], facts());
    expect(outcome.matched).toEqual([0, 1]);
    expect(outcome.actions.map((a) => a.type)).toEqual(['add_label', 'move', 'star']);
  });

  it('ignore les règles inactives', () => {
    expect(evaluateRules([{ ...invoice, enabled: false }], facts()).matched).toEqual([]);
  });

  it('match « all » exige toutes les conditions', () => {
    expect(evaluateRule(invoice, facts({ subject: 'Bonjour' }))).toBe(false);
  });

  it('signale une expression invalide sans interrompre les autres règles', () => {
    const broken = {
      ...anyRule,
      conditions: [{ field: 'subject', op: 'matches', value: '(' }],
    } as Rule;
    const outcome = evaluateRules([broken, anyRule], facts());
    expect(outcome.errors).toEqual([{ index: 0, code: 'invalid_pattern' }]);
    expect(outcome.matched).toEqual([1]);
  });

  it('arrête l’évaluation au-delà du budget de temps', () => {
    let t = 0;
    const outcome = evaluateRules([anyRule, anyRule, anyRule], facts(), {
      budgetMs: 10,
      now: () => (t += 6),
    });
    expect(outcome.errors).toEqual([{ index: 1, code: 'budget_exceeded' }]);
  });
});

describe('politique', () => {
  const forward = (to: string) =>
    rule({
      conditions: [{ field: 'subject', op: 'contains', value: 'x' }],
      actions: [{ type: 'forward', to }],
    });
  const policy = { forwardEnabled: true, forwardDomains: ['exemple.com', '*.exemple.fr'] };

  it.each([
    ['alice@exemple.com', []],
    ['bob@eu.exemple.fr', []],
    ['bob@exemple.fr', ['forward_destination_not_allowed']],
    ['x@evil.example', ['forward_destination_not_allowed']],
    ['x@exemple.com.evil.example', ['forward_destination_not_allowed']],
    ['pas-une-adresse', ['invalid_forward_address']],
    ['a@b@exemple.com', ['invalid_forward_address']],
  ])('transfert vers %s', (to, codes) => {
    expect(checkRule(forward(to), policy).map((i) => i.code)).toEqual(codes);
  });

  it('refuse tout transfert si désactivé ou sans domaine', () => {
    expect(
      checkRule(forward('alice@exemple.com'), {
        forwardEnabled: false,
        forwardDomains: ['exemple.com'],
      })[0]?.code,
    ).toBe('forward_disabled');
    expect(
      checkRule(forward('alice@exemple.com'), { forwardEnabled: true, forwardDomains: [] })[0]
        ?.code,
    ).toBe('forward_disabled');
  });

  it('signale les expressions invalides et les actions contradictoires', () => {
    const r = rule({
      conditions: [{ field: 'subject', op: 'matches', value: '(a)\\1' }],
      actions: [{ type: 'archive' }, { type: 'delete' }],
    });
    expect(checkRule(r, policy).map((i) => i.code)).toEqual([
      'invalid_pattern',
      'conflicting_actions',
    ]);
  });

  it('domainAllowed', () => {
    expect(domainAllowed('A.Exemple.FR', ['*.exemple.fr'])).toBe(true);
    expect(domainAllowed('exemple.fr', ['*.exemple.fr'])).toBe(false);
  });
});

describe('réponses automatiques et transferts', () => {
  const self = 'sacha@exemple.com';
  it('répond à un expéditeur ordinaire', () => {
    expect(
      canAutoReply(facts({ from: [{ name: 'Alice', address: 'alice@exemple.fr' }] }), self),
    ).toBe(true);
  });

  it.each([
    ['liste (List-Id)', { headers: { 'list-id': ['<l.exemple.fr>'] } }],
    ['liste (List-Unsubscribe)', { headers: { 'list-unsubscribe': ['<mailto:u@x.fr>'] } }],
    ['Precedence: bulk', { headers: { precedence: ['Bulk'] } }],
    ['Auto-Submitted', { headers: { 'auto-submitted': ['auto-replied'] } }],
    ['noreply', { from: [{ name: '', address: 'no-reply@exemple.fr' }] }],
    ['noreply sans tiret', { from: [{ name: '', address: 'noreply@exemple.fr' }] }],
    ['mailer-daemon', { from: [{ name: '', address: 'MAILER-DAEMON@exemple.fr' }] }],
    ['bounce', { from: [{ name: '', address: 'bounces+123@exemple.fr' }] }],
    ['soi-même', { from: [{ name: '', address: 'Sacha@exemple.com' }] }],
    ['sans expéditeur', { from: [] }],
  ])('ne répond pas : %s', (_name, patch) => {
    expect(canAutoReply(facts(patch as Partial<MessageFacts>), self)).toBe(false);
  });

  it('accepte Auto-Submitted: no', () => {
    expect(
      canAutoReply(
        facts({ headers: { 'auto-submitted': ['no'] }, from: [{ name: '', address: 'a@b.fr' }] }),
        self,
      ),
    ).toBe(true);
  });

  it('ne re-transfère pas un message déjà transféré ou automatique', () => {
    expect(canForward(facts(), {})).toBe(true);
    expect(canForward(facts(), { 'x-plume-forwarded': ['1'] })).toBe(false);
    expect(canForward(facts({ headers: { 'auto-submitted': ['auto-generated'] } }), {})).toBe(
      false,
    );
  });
});

describe('cas limites', () => {
  it('évince les expressions les plus anciennes du cache (1 000 au plus)', () => {
    const first = compilePattern('^premier$');
    for (let i = 0; i < 1000; i++) compilePattern(`^motif-${i}$`);
    expect(compilePattern('^premier$')).not.toBe(first);
  });

  it('champ ou opérateur inconnus (données non validées) : aucune correspondance', () => {
    const unknownField = { field: 'inconnu', op: 'contains', value: 'x' } as unknown as Parameters<
      typeof evaluateCondition
    >[0];
    const unknownOp = { field: 'subject', op: 'inconnu', value: 'x' } as unknown as Parameters<
      typeof evaluateCondition
    >[0];
    expect(evaluateCondition(unknownField, facts())).toBe(false);
    expect(evaluateCondition(unknownOp, facts())).toBe(false);
  });
});
