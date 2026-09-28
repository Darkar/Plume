// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Le seul script en ligne (apparence appliquée avant le premier rendu) est autorisé par son
 * empreinte dans la CSP de Caddy : toute modification du script doit mettre à jour l'empreinte.
 */
describe('CSP : empreinte du script en ligne', () => {
  it('correspond à celle déclarée dans le Caddyfile', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const caddyfile = readFileSync(new URL('../../../deploy/Caddyfile', import.meta.url), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
    expect(scripts).toHaveLength(1);
    const hash = `'sha256-${createHash('sha256').update(scripts[0]!).digest('base64')}'`;
    expect(caddyfile).toContain(`script-src 'self' ${hash}`);
    // Aucun autre moyen d'exécuter du script en ligne.
    expect(caddyfile).not.toMatch(/script-src[^;"]*'unsafe-inline'/);
  });
});
