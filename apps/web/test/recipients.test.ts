import { describe, expect, it } from 'vitest';
import { formatRecipients, parseRecipients } from '../src/mail/recipients';

describe('parseRecipients', () => {
  it('analyse les formes usuelles', () => {
    expect(parseRecipients('a@b.fr, "Alice Dupont" <Alice@Exemple.fr>; c@d.fr\n')).toEqual({
      valid: [
        { name: '', address: 'a@b.fr' },
        { name: 'Alice Dupont', address: 'alice@exemple.fr' },
        { name: '', address: 'c@d.fr' },
      ],
      invalid: [],
    });
  });

  it('signale les entrées invalides', () => {
    expect(parseRecipients('pas-une-adresse, a@b, x y@z.fr').invalid).toEqual([
      'pas-une-adresse',
      'a@b',
      'x y@z.fr',
    ]);
  });

  it('formatRecipients est l’inverse', () => {
    const list = [
      { name: 'Alice', address: 'alice@exemple.fr' },
      { name: '', address: 'b@c.fr' },
    ];
    expect(parseRecipients(formatRecipients(list)).valid).toEqual(list);
  });
});
