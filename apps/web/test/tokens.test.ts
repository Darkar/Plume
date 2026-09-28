// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Contrastes WCAG 2.2 AA des jetons de thème, pour chaque accent et chaque thème :
 * texte ≥ 4.5:1, composants d'interface (bordures, focus) ≥ 3:1.
 */
const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

/** Variables du premier bloc `selector { … }` qui définit `key`. */
function block(selector: string, key: string): Record<string, string> {
  let from = 0;
  for (;;) {
    const start = css.indexOf(`${selector} {`, from);
    if (start < 0) throw new Error(`bloc introuvable : ${selector} (${key})`);
    const body = css.slice(start, css.indexOf('}', start));
    if (body.includes(`${key}:`)) {
      return Object.fromEntries(
        [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]!.trim()]),
      );
    }
    from = start + 1;
  }
}

type Rgb = [number, number, number];

function parse(value: string): Rgb {
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
  }
  const nums = value.match(/\d+/g)!.map(Number);
  return [nums[0]!, nums[1]!, nums[2]!];
}

function luminance([r, g, b]: Rgb): number {
  const c = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

function contrast(a: Rgb, b: Rgb): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}

/** Couleur translucide posée sur un fond (fond de ligne sélectionnée). */
function blend(color: Rgb, alpha: number, background: Rgb): Rgb {
  return color.map((c, i) => Math.round(c * alpha + background[i]! * (1 - alpha))) as Rgb;
}

const ACCENTS = ['indigo', 'blue', 'teal', 'green', 'orange', 'rose'];
const light = block(':root', '--color-bg');
const dark = block(":root[data-theme='dark']", '--color-bg');
// Aplat des boutons : `--accent-light` avec texte blanc dans les deux thèmes ; texte d'accent :
// `textKey` (plus clair en thème sombre).
const THEMES = [
  { name: 'clair', vars: light, textKey: '--accent-light', soft: 0.1 },
  { name: 'sombre', vars: dark, textKey: '--accent-dark', soft: 0.12 },
];

describe('contrastes AA', () => {
  for (const theme of THEMES) {
    const v = (name: string) => parse(theme.vars[name]!);
    const backgrounds = ['--color-bg', '--color-surface', '--color-surface-muted'];

    it(`thème ${theme.name} : textes et composants`, () => {
      for (const bg of backgrounds) {
        expect(contrast(v('--color-text'), v(bg)), `texte sur ${bg}`).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(v('--color-text-muted'), v(bg)),
          `texte secondaire sur ${bg}`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(v('--color-border-strong'), v(bg)),
          `bordure sur ${bg}`,
        ).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(v('--color-danger'), v('--color-surface'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v('--color-danger-contrast'), v('--color-danger'))).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrast(v('--color-text'), v('--color-danger-surface'))).toBeGreaterThanOrEqual(4.5);
    });

    for (const accent of ACCENTS) {
      it(`thème ${theme.name}, accent ${accent}`, () => {
        const vars = block(`:root[data-accent='${accent}']`, '--accent-light');
        const fill = parse(vars['--accent-light']!);
        const color = parse(vars[theme.textKey]!);
        expect(parse(vars[`${theme.textKey}-rgb`]!)).toEqual(color);
        // Texte des boutons pleins.
        expect(contrast([255, 255, 255], fill)).toBeGreaterThanOrEqual(4.5);
        for (const bg of backgrounds) {
          // Liens et éléments actifs.
          expect(contrast(color, v(bg)), `${accent} sur ${bg}`).toBeGreaterThanOrEqual(4.5);
          // Élément sélectionné : texte d'accent sur fond d'accent translucide.
          const selected = blend(color, theme.soft, v(bg));
          expect(
            contrast(color, selected),
            `${accent} sélectionné sur ${bg}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }

  it('pastilles (avatars, libellés) : texte blanc lisible', () => {
    const root = block(':root', '--swatch-1');
    for (let i = 1; i <= 8; i++) {
      const swatch = parse(root[`--swatch-${i}`]!);
      expect(contrast([255, 255, 255], swatch), `pastille ${i}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
