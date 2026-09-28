import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  BODY_HEIGHT_SCRIPT,
  BODY_HEIGHT_SCRIPT_HASH,
  escapeHtml,
  sanitizeEmailHtml,
  textToSafeHtml,
} from '../src/sanitize.js';
import { XSS_PAYLOADS } from './fixtures/xss-corpus.js';

const block = { remoteImages: 'block' as const };

function parse(html: string) {
  return new JSDOM(html).window.document;
}

const FORBIDDEN_TAGS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'svg',
  'math',
  'meta',
  'link',
  'base',
  'template',
  'noscript',
  'video',
  'audio',
  'source',
  'xss',
  'isindex',
  'keygen',
  'marquee',
];

/** Vérifie structurellement qu'aucun vecteur d'exécution ne subsiste. */
function assertInert(html: string) {
  const doc = parse(html);
  // Un seul script : celui de mesure de hauteur, ajouté par nous dans <head>, à l'identique.
  const scripts = [...doc.getElementsByTagName('script')];
  expect(scripts).toHaveLength(1);
  expect(scripts[0]?.parentElement?.tagName).toBe('HEAD');
  expect(scripts[0]?.textContent).toBe(BODY_HEIGHT_SCRIPT);
  expect(scripts[0]?.attributes).toHaveLength(0);
  for (const tag of FORBIDDEN_TAGS) {
    if (tag === 'script') continue;
    // La seule balise meta autorisée est celle que nous ajoutons nous-mêmes.
    const found = [...doc.getElementsByTagName(tag)].filter(
      (el) =>
        !(tag === 'meta' && (el.hasAttribute('charset') || el.getAttribute('name') === 'referrer')),
    );
    expect(found, `<${tag}> présent`).toHaveLength(0);
  }
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of el.getAttributeNames()) {
      expect(attr.startsWith('on'), `attribut ${attr}`).toBe(false);
      const value = el.getAttribute(attr) ?? '';
      if (
        ['href', 'src', 'action', 'formaction', 'background', 'lowsrc', 'dynsrc'].includes(attr)
      ) {
        expect(value).not.toMatch(/^\s*(javascript|vbscript|data:text|data:image\/svg)/i);
      }
    }
    const style = el.getAttribute('style') ?? '';
    expect(style).not.toMatch(/expression|javascript|behavio|binding|\\/i);
  }
  for (const style of doc.querySelectorAll('style')) {
    expect(style.textContent).not.toMatch(/expression|javascript|@import|binding|behavio|\\/i);
  }
}

describe('sanitizeEmailHtml — corpus XSS', () => {
  it.each(XSS_PAYLOADS.map((p, i) => [i, p]))('charge n°%i est neutralisée', (_i, payload) => {
    const { html } = sanitizeEmailHtml(payload as string, block);
    assertInert(html);
  });

  it.each(XSS_PAYLOADS.map((p, i) => [i, p]))(
    'charge n°%i ne s’exécute pas dans un navigateur simulé',
    async (_i, payload) => {
      const { html } = sanitizeEmailHtml(payload as string, block);
      const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
      // Déclenche les gestionnaires usuels au cas où l'un aurait survécu.
      for (const el of dom.window.document.querySelectorAll('*')) {
        for (const type of ['load', 'error', 'click', 'mouseover', 'focus', 'toggle']) {
          el.dispatchEvent(new dom.window.Event(type));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect((dom.window as unknown as { __xss?: unknown }).__xss).toBeUndefined();
      dom.window.close();
    },
  );
});

describe('sanitizeEmailHtml — rendu', () => {
  it('conserve la mise en forme courante', () => {
    const { html } = sanitizeEmailHtml(
      '<table width="100%"><tr><td style="color:#333;padding:8px" align="center"><b>Bonjour</b> <em>monde</em></td></tr></table>',
      block,
    );
    const doc = parse(html);
    const td = doc.querySelector('td');
    expect(td?.getAttribute('style')).toBe('color:#333;padding:8px');
    expect(td?.getAttribute('align')).toBe('center');
    expect(doc.querySelector('b')?.textContent).toBe('Bonjour');
  });

  it('conserve les feuilles de style de l’en-tête, nettoyées', () => {
    const { html } = sanitizeEmailHtml(
      '<html><head><style>.a{color:red}</style><title>t</title></head><body><p class="a">x</p></body></html>',
      block,
    );
    const doc = parse(html);
    expect([...doc.querySelectorAll('style')].map((s) => s.textContent).join('')).toContain(
      '.a{color:red}',
    );
    expect(doc.querySelector('title')).toBeNull();
  });

  it('bloque les images distantes et les compte', () => {
    const { html, blockedRemote } = sanitizeEmailHtml(
      '<img src="https://tracker.example/p.gif"><div style="background:url(https://t.example/b.png)">x</div><img src="//cdn.example/x.png">',
      block,
    );
    expect(blockedRemote).toBe(3);
    expect(html).not.toContain('tracker.example');
    expect(html).not.toContain('t.example');
    expect(html).not.toContain('cdn.example');
  });

  it('réécrit les images distantes vers le proxy quand l’utilisateur les autorise', () => {
    const { html, blockedRemote } = sanitizeEmailHtml(
      '<img src="https://images.example/a.png"><p style="background-image:url(\'https://images.example/b.png\')">x</p>',
      {
        remoteImages: 'proxy',
        proxyUrl: (u) => `/api/v1/image-proxy?url=${encodeURIComponent(u)}&sig=s`,
      },
    );
    expect(blockedRemote).toBe(0);
    const doc = parse(html);
    expect(doc.querySelector('img')?.getAttribute('src')).toBe(
      '/api/v1/image-proxy?url=https%3A%2F%2Fimages.example%2Fa.png&sig=s',
    );
    expect(doc.querySelector('p')?.getAttribute('style')).toContain('/api/v1/image-proxy?url=');
  });

  it('résout les images intégrées (cid:)', () => {
    const { html } = sanitizeEmailHtml('<img src="cid:logo@plume"><img src="cid:inconnu">', {
      ...block,
      resolveCid: (cid) => (cid === 'logo@plume' ? '/api/v1/attachments/abc?sig=1' : null),
    });
    const imgs = parse(html).querySelectorAll('img');
    expect(imgs[0]?.getAttribute('src')).toBe('/api/v1/attachments/abc?sig=1');
    expect(imgs[1]?.hasAttribute('src')).toBe(false);
  });

  it('accepte les images data: raster mais pas SVG', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const svg = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
    const doc = parse(sanitizeEmailHtml(`<img src="${png}"><img src="${svg}">`, block).html);
    const imgs = doc.querySelectorAll('img');
    expect(imgs[0]?.getAttribute('src')).toBe(png);
    expect(imgs[1]?.hasAttribute('src')).toBe(false);
  });

  it('ouvre les liens externes sans référent', () => {
    const doc = parse(
      sanitizeEmailHtml(
        '<a href="https://example.org" target="_top">x</a><a href="#s">y</a>',
        block,
      ).html,
    );
    const [ext, anchor] = doc.querySelectorAll('a');
    expect(ext?.getAttribute('target')).toBe('_blank');
    expect(ext?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(anchor?.hasAttribute('target')).toBe(false);
  });

  it('ajoute ses propres en-têtes et aucune balise de l’expéditeur', () => {
    const doc = parse(
      sanitizeEmailHtml(
        '<head><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"></head>x',
        block,
      ).html,
    );
    expect(doc.querySelector('meta[http-equiv]')).toBeNull();
    expect(doc.querySelector('base')).toBeNull();
    expect(doc.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
  });
});

describe('textToSafeHtml', () => {
  it('échappe le texte et rend les liens cliquables', () => {
    const { html } = textToSafeHtml(
      '<script>window.__xss=1</script> voir https://example.org/a?b=1&c=2',
    );
    const doc = parse(html);
    // Seul le script de mesure de hauteur, dans <head> ; celui du texte reste du texte.
    expect(doc.querySelector('body script')).toBeNull();
    expect(doc.querySelector('head script')?.textContent).toBe(BODY_HEIGHT_SCRIPT);
    expect(doc.querySelector('pre')?.textContent).toContain('<script>');
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('https://example.org/a?b=1&c=2');
  });

  it('ne permet pas de sortir de l’attribut href', () => {
    const doc = parse(textToSafeHtml('https://example.org/"onmouseover="window.__xss=1').html);
    const a = doc.querySelector('a');
    expect(a?.getAttribute('onmouseover')).toBeNull();
  });

  it('escapeHtml échappe les cinq caractères spéciaux', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('thème du document', () => {
  const block = { remoteImages: 'block' as const };

  it('clair par défaut', () => {
    const { html } = sanitizeEmailHtml('<p>Bonjour</p>', block);
    expect(html).toContain('color-scheme:light');
    expect(html).toContain('background:#fff');
  });

  it('sombre pour un mail sans couleurs imposées (HTML ou texte)', () => {
    expect(sanitizeEmailHtml('<p>Bonjour</p>', { ...block, theme: 'dark' }).html).toContain(
      'color-scheme:dark',
    );
    expect(textToSafeHtml('Bonjour', 'dark').html).toContain('color-scheme:dark');
  });

  it.each([
    '<p style="color: #333">Bonjour</p>',
    '<table bgcolor="#ffffff"><tr><td>Bonjour</td></tr></table>',
    '<div style="background-color:#fafafa">Bonjour</div>',
    '<style>p{color:#222}</style><p>Bonjour</p>',
    '<font color="#333333">Bonjour</font>',
  ])('reste clair en thème sombre si le mail impose ses couleurs (%s)', (input) => {
    const { html } = sanitizeEmailHtml(input, { ...block, theme: 'dark' });
    expect(html).toContain('color-scheme:light');
    expect(html).not.toContain('color-scheme:dark');
  });
});

describe('hauteur du corps (iframe ajustée au contenu)', () => {
  it('l’empreinte CSP correspond au script ajouté', async () => {
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(BODY_HEIGHT_SCRIPT).digest('base64');
    expect(BODY_HEIGHT_SCRIPT_HASH).toBe(`'sha256-${digest}'`);
    expect(textToSafeHtml('bonjour').html).toContain(`<script>${BODY_HEIGHT_SCRIPT}</script>`);
  });

  it('neutralise les unités relatives à la hauteur de la fenêtre', () => {
    const { html } = sanitizeEmailHtml(
      '<style>.a{min-height:100vh}.b{height:calc(50dvh - 2px)}.c{width:100vw}</style>' +
        '<div style="height:100vh;max-height:80vmin">x</div>',
      block,
    );
    expect(html).not.toMatch(/\d(?:[sld]?vh|vmin|vmax)\b/);
    expect(html).toContain('min-height:auto');
    expect(html).toContain('width:100vw');
  });
});

describe('document sans bloc défilant', () => {
  it('impose une hauteur automatique après les styles du mail', () => {
    const { html } = sanitizeEmailHtml(
      '<html><head><style>html,body{height:100%;overflow:auto}</style></head>' +
        '<body style="height:100%;overflow-y:scroll"><p>x</p></body></html>',
      block,
    );
    const doc = new JSDOM(html).window.document;
    const styles = [...doc.head.querySelectorAll('style')];
    // La dernière feuille (la nôtre) l'emporte : spécificité d'identifiant et !important.
    expect(styles.at(-1)?.textContent).toContain(':is(body,#plume-id){height:auto!important');
    expect(styles.at(-1)?.textContent).toContain('overflow-y:hidden!important');
    expect(textToSafeHtml('x').html).toContain(':is(html,#plume-id)');
  });
});
