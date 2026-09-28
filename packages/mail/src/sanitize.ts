import { createHash } from 'node:crypto';
import createDOMPurify, { type Config } from 'dompurify';
import { JSDOM } from 'jsdom';

/**
 * Nettoyage côté serveur du HTML des mails (contenu NON FIABLE).
 *
 * Défense en profondeur : le résultat est ensuite affiché dans une iframe `sandbox` sans
 * `allow-same-origin` (origine opaque), servie avec sa propre CSP dont `script-src` n'autorise
 * que le script de mesure de hauteur ci-dessous, par son empreinte (D-064).
 */

/**
 * Seul script autorisé dans le document du mail : transmet la hauteur du contenu à l'interface,
 * qui ajuste l'iframe (le mail se lit en entier, avec un seul défilement). Placé dans `<head>`,
 * avant tout contenu du mail. Aucune donnée du mail n'est transmise, seulement un nombre.
 */
export const BODY_HEIGHT_SCRIPT =
  '(function(){var last=0;function send(){var d=document.documentElement;' +
  'var h=Math.ceil(d.getBoundingClientRect().height);' +
  'if(d.scrollHeight>d.clientHeight)h=Math.max(h,d.scrollHeight+(innerHeight-d.clientHeight));' +
  "if(h!==last){last=h;parent.postMessage({type:'plume:body-height',height:h},'*');}}" +
  'var ro=new ResizeObserver(send);ro.observe(document.documentElement);' +
  "addEventListener('DOMContentLoaded',function(){ro.observe(document.body);send();});" +
  "addEventListener('load',send);})();";

/** Source CSP autorisant uniquement {@link BODY_HEIGHT_SCRIPT}. */
export const BODY_HEIGHT_SCRIPT_HASH = `'sha256-${createHash('sha256').update(BODY_HEIGHT_SCRIPT).digest('base64')}'`;

const HEAD_SCRIPT = `<script>${BODY_HEIGHT_SCRIPT}</script>`;

/**
 * Placé après les styles du mail : le document prend la hauteur de son contenu et ne défile
 * jamais verticalement (l'iframe est ajustée à cette hauteur). « :is(…, #plume-id) » donne à
 * ces règles une spécificité d'identifiant, et « !important » l'emporte sur les styles en
 * ligne : un mail qui fixe « html, body { height: 100%; overflow: auto } » ne peut pas
 * recréer un bloc défilant.
 */
const LAYOUT_OVERRIDE =
  '<style>:is(html,#plume-id){height:auto!important;min-height:0!important;max-height:none!important;overflow-y:hidden!important}' +
  ':is(body,#plume-id){height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important}</style>';

const { window } = new JSDOM('');
const purify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);

const ALLOWED_TAGS = [
  'html',
  'head',
  'body',
  'style',
  'a',
  'abbr',
  'address',
  'article',
  'aside',
  'b',
  'bdi',
  'bdo',
  'big',
  'blockquote',
  'br',
  'caption',
  'center',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'font',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'main',
  'mark',
  'nav',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'samp',
  'section',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'tt',
  'u',
  'ul',
  'var',
  'wbr',
];

const ALLOWED_ATTR = [
  'abbr',
  'align',
  'alt',
  'bgcolor',
  'border',
  'cellpadding',
  'cellspacing',
  'cite',
  'class',
  'color',
  'colspan',
  'datetime',
  'dir',
  'face',
  'headers',
  'height',
  'href',
  'hspace',
  'lang',
  'reversed',
  'rowspan',
  'scope',
  'size',
  'span',
  'src',
  'start',
  'style',
  'summary',
  'title',
  'type',
  'valign',
  'vspace',
  'width',
];

const PURIFY_CONFIG: Config = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  WHOLE_DOCUMENT: true,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  // Schémas autorisés : http(s), mailto et tel. DOMPurify applique aussi ce filtre aux valeurs des
  // attributs ordinaires (align, width…) : les valeurs sans schéma restent donc acceptées.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  SANITIZE_DOM: true,
  SANITIZE_NAMED_PROPS: true,
  KEEP_CONTENT: true,
  FORBID_TAGS: [
    'svg',
    'math',
    'form',
    'input',
    'button',
    'select',
    'textarea',
    'iframe',
    'frame',
    'frameset',
    'object',
    'embed',
    'applet',
    'script',
    'noscript',
    'template',
    'meta',
    'link',
    'base',
    'title',
    'video',
    'audio',
    'source',
    'track',
    'picture',
    'canvas',
    'dialog',
    'portal',
    'xmp',
    'plaintext',
    'listing',
    'noembed',
    'noframes',
  ],
  FORBID_ATTR: [
    'background',
    'srcset',
    'action',
    'formaction',
    'ping',
    'poster',
    'xlink:href',
    'target',
    'rel',
    'id',
    'name',
  ],
};

const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i;
const MAX_DATA_IMAGE_LENGTH = 2 * 1024 * 1024;

export type RemoteImagePolicy = 'block' | 'proxy';

export interface SanitizeOptions {
  /** Résout une référence `cid:` vers l'URL (signée) de la pièce jointe correspondante. */
  resolveCid?: (contentId: string) => string | null;
  /** `block` : images distantes retirées ; `proxy` : réécrites vers le proxy d'images. */
  remoteImages: RemoteImagePolicy;
  /** Construit l'URL (signée) du proxy pour une image distante. */
  proxyUrl?: (url: string) => string;
  /** Thème de l'interface (sombre : appliqué seulement aux mails sans couleurs imposées). */
  theme?: BodyTheme;
}

export type BodyTheme = 'light' | 'dark';

export interface SanitizeResult {
  html: string;
  /** Nombre de ressources distantes bloquées (images, arrière-plans CSS). */
  blockedRemote: number;
}

interface Context {
  options: SanitizeOptions;
  blocked: number;
}

let context: Context | null = null;

type UrlDecision = { keep: true; url: string } | { keep: false };

/** Décide du sort d'une URL de ressource (image ou `url()` CSS). */
function resolveResourceUrl(raw: string, ctx: Context): UrlDecision {
  const url = raw.trim();
  if (SAFE_DATA_IMAGE_RE.test(url) && url.length <= MAX_DATA_IMAGE_LENGTH) {
    return { keep: true, url };
  }
  if (/^cid:/i.test(url)) {
    const resolved = ctx.options.resolveCid?.(
      decodeURIComponent(url.slice(4)).replace(/^<|>$/g, ''),
    );
    return resolved ? { keep: true, url: resolved } : { keep: false };
  }
  if (/^https?:\/\//i.test(url)) {
    if (ctx.options.remoteImages === 'proxy' && ctx.options.proxyUrl) {
      return { keep: true, url: ctx.options.proxyUrl(url) };
    }
    ctx.blocked += 1;
    return { keep: false };
  }
  // Protocole relatif (« //hote/img »), javascript:, data: non image, file:… : refusés.
  if (/^\/\//.test(url)) ctx.blocked += 1;
  return { keep: false };
}

// Constructions CSS dangereuses ou permettant de charger une ressource hors de notre contrôle.
const CSS_FORBIDDEN_RE =
  /expression\s*\(|behaviou?r\s*:|-moz-binding|javascript:|vbscript:|@import|@font-face|@namespace|image-set\s*\(|-webkit-image-set|src\s*\(/i;
const CSS_URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
/**
 * Unités relatives à la hauteur de la fenêtre : l'iframe prend la hauteur du contenu, « 100vh » la ferait
 * grandir sans fin. Remplacées par « auto » (une déclaration devenue invalide est ignorée).
 */
const VIEWPORT_UNIT_RE = /-?(?:\d+\.?\d*|\.\d+)[sld]?v(?:h|min|max|b)\b/gi;

function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d)
      return true;
  }
  return false;
}

/**
 * Nettoie une feuille de style ou une déclaration `style`. Toute séquence d'échappement CSS
 * (« \75 rl( ») ou construction interdite entraîne le rejet du bloc entier.
 */
function sanitizeCss(css: string, ctx: Context): string | null {
  if (css.includes('\\') || css.includes('<') || hasControlChars(css)) {
    return null;
  }
  if (CSS_FORBIDDEN_RE.test(css)) return null;
  // Les commentaires peuvent servir à masquer des constructions interdites (« exp/**/ression »).
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (CSS_FORBIDDEN_RE.test(withoutComments)) return null;
  return withoutComments
    .replace(VIEWPORT_UNIT_RE, 'auto')
    .replace(CSS_URL_RE, (_match, _quote, url: string) => {
      const decision = resolveResourceUrl(url, ctx);
      return decision.keep ? `url("${decision.url.replace(/["\n\r]/g, '')}")` : 'none';
    });
}

purify.addHook('uponSanitizeElement', (node, data) => {
  if (!context) return;
  if (data.tagName === 'style') {
    const css = sanitizeCss(node.textContent ?? '', context);
    node.textContent = css ?? '';
  }
});

purify.addHook('uponSanitizeAttribute', (node, data) => {
  if (!context) return;
  if (data.attrName === 'style') {
    const css = sanitizeCss(data.attrValue, context);
    if (css === null) data.keepAttr = false;
    else data.attrValue = css;
    return;
  }
  if (data.attrName === 'src') {
    if (node.nodeName !== 'IMG') {
      data.keepAttr = false;
      return;
    }
    const decision = resolveResourceUrl(data.attrValue, context);
    if (decision.keep) {
      // Les URL déjà validées ne doivent pas être rejetées par le filtre d'URI de DOMPurify :
      // « forceKeepAttr » conserve la valeur présente sur le nœud, d'où l'écriture directe.
      node.setAttribute('src', decision.url);
      data.attrValue = decision.url;
      data.forceKeepAttr = true;
    } else {
      data.keepAttr = false;
    }
  }
});

purify.addHook('afterSanitizeAttributes', (node) => {
  if (!context) return;
  if (node.nodeName === 'A' && node.hasAttribute('href')) {
    const href = node.getAttribute('href') ?? '';
    if (!href.startsWith('#')) {
      // Ouverture dans un nouvel onglet, sans référent ni accès à la page d'origine.
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  }
  if (node.nodeName === 'IMG') {
    node.setAttribute('referrerpolicy', 'no-referrer');
    node.setAttribute('loading', 'lazy');
  }
});

// « flow-root » : les flottants du mail comptent dans la hauteur mesurée.
const LAYOUT_STYLE =
  'html,body{margin:0;padding:0}body{display:flow-root;padding:16px;font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap;font:inherit}';
const LIGHT_STYLE = ':root{color-scheme:light}body{color:#171717;background:#fff}';
/** Fond transparent : le document se fond dans le panneau de lecture sombre. */
const DARK_STYLE =
  ':root{color-scheme:dark}body{color:#ededed;background:transparent}a{color:#a5adff}blockquote{border-left:2px solid #444;margin-left:0;padding-left:12px;color:#b5b5b5}';

/**
 * Un mail qui impose ses couleurs (texte, fonds) reste sur fond clair même en thème sombre :
 * ses choix supposent un fond blanc et deviendraient illisibles.
 */
const STYLED_RE =
  /(?:^|[\s;"'{])(?:color|background(?:-color|-image)?)\s*:|\bbgcolor\s*=|<font\b[^>]*\bcolor\s*=/i;

function baseStyle(theme: BodyTheme | undefined, styled: boolean): string {
  return LAYOUT_STYLE + (theme === 'dark' && !styled ? DARK_STYLE : LIGHT_STYLE);
}

/** Nettoie le HTML d'un mail et renvoie un document complet prêt pour l'iframe isolée. */
export function sanitizeEmailHtml(html: string, options: SanitizeOptions): SanitizeResult {
  const ctx: Context = { options, blocked: 0 };
  context = ctx;
  let clean: string;
  try {
    clean = String(purify.sanitize(html, PURIFY_CONFIG));
  } finally {
    context = null;
  }
  // DOMPurify renvoie « <html><head>…</head><body>…</body></html> » (WHOLE_DOCUMENT).
  const headMatch = /<head>([\s\S]*?)<\/head>/i.exec(clean);
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(clean);
  const headContent = headMatch?.[1] ?? '';
  const bodyContent = bodyMatch?.[1] ?? clean;
  const document =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="referrer" content="no-referrer">' +
    `<style>${baseStyle(options.theme, STYLED_RE.test(headContent + bodyContent))}</style>` +
    HEAD_SCRIPT +
    `${headContent}${LAYOUT_OVERRIDE}</head><body>${bodyContent}</body></html>`;
  return { html: document, blockedRemote: ctx.blocked };
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] as string);
}

/** Convertit un mail en texte brut en document HTML sûr (échappé, liens http(s) cliquables). */
export function textToSafeHtml(text: string, theme?: BodyTheme): SanitizeResult {
  const escaped = escapeHtml(text);
  const linked = escaped.replace(
    /\bhttps?:\/\/[^\s<>"']{1,2000}/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`,
  );
  const document =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="referrer" content="no-referrer">' +
    `<style>${baseStyle(theme, false)}</style>${HEAD_SCRIPT}${LAYOUT_OVERRIDE}</head>` +
    `<body><pre>${linked}</pre></body></html>`;
  return { html: document, blockedRemote: 0 };
}
