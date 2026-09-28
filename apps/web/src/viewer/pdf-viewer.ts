/**
 * Visionneuse PDF isolée. Cette page est chargée dans une `iframe sandbox="allow-scripts"` SANS
 * `allow-same-origin` : elle s'exécute dans une origine opaque, sans accès aux cookies, au
 * stockage ni au document de l'application. Le PDF lui est transmis par `postMessage` (octets
 * uniquement) ; pdf.js le dessine dans des canevas, sans exécuter les scripts du document
 * (pdf.js n'implémente pas JavaScript PDF hors de sa visionneuse complète ; pdf.js 6 n'utilise
 * pas `eval`).
 *
 * Navigation : zoom (boutons, + / - / 0, Ctrl + molette), ajustement à la largeur, saisie
 * directe du numéro de page. Seules les pages visibles sont dessinées, à la résolution du zoom.
 */
import './polyfills';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import * as pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs';

// Pas de Worker (impossible depuis une origine opaque) : le code du worker est embarqué et pdf.js
// l'exécute sur le fil principal (« fake worker »).
(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfWorker;
GlobalWorkerOptions.workerSrc = '';

const MAX_PAGES = 200;
const MAX_BYTES = 50 * 1024 * 1024;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
/** Plafond de pixels par canevas (mémoire) : au-delà, la résolution est réduite. */
const MAX_CANVAS_PIXELS = 16_000_000;

const TEXTS = {
  fr: {
    loading: 'Chargement…',
    failed: 'Impossible d’afficher ce PDF.',
    toolbar: 'Navigation dans le document',
    previous: 'Page précédente',
    next: 'Page suivante',
    page: 'Page',
    of: 'sur',
    zoomOut: 'Zoom arrière',
    zoomIn: 'Zoom avant',
    zoom: 'Zoom',
    fit: 'Ajuster à la largeur',
    pageLabel: (n: number, total: number) => `Page ${n} sur ${total}`,
    more: (n: number) => `… ${n} page(s) non affichée(s).`,
  },
  en: {
    loading: 'Loading…',
    failed: 'This PDF cannot be displayed.',
    toolbar: 'Document navigation',
    previous: 'Previous page',
    next: 'Next page',
    page: 'Page',
    of: 'of',
    zoomOut: 'Zoom out',
    zoomIn: 'Zoom in',
    zoom: 'Zoom',
    fit: 'Fit to width',
    pageLabel: (n: number, total: number) => `Page ${n} of ${total}`,
    more: (n: number) => `… ${n} more page(s) not shown.`,
  },
};
type Texts = (typeof TEXTS)['fr'];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scroller = $<HTMLElement>('pages');
const status = $<HTMLElement>('status');
const toolbar = $<HTMLElement>('toolbar');
const pageInput = $<HTMLInputElement>('page');
const pageCount = $<HTMLElement>('count');
const zoomLabel = $<HTMLElement>('zoom');

interface Slot {
  n: number;
  element: HTMLDivElement;
  width: number;
  height: number;
  rendered: number | null;
  task: { cancel(): void } | null;
}

let pdf: PDFDocumentProxy | null = null;
const slots: Slot[] = [];
let scale = 1;
let fitWidth = true;
let texts: Texts = TEXTS.fr;

function applyTexts(): void {
  document.documentElement.lang = texts === TEXTS.en ? 'en' : 'fr';
  toolbar.setAttribute('aria-label', texts.toolbar);
  for (const [id, key] of [
    ['prev', 'previous'],
    ['next', 'next'],
    ['zoom-out', 'zoomOut'],
    ['zoom-in', 'zoomIn'],
    ['fit', 'fit'],
  ] as const) {
    const button = $<HTMLButtonElement>(id);
    button.setAttribute('aria-label', texts[key]);
    button.title = texts[key];
  }
  pageInput.setAttribute('aria-label', texts.page);
  zoomLabel.setAttribute('aria-label', texts.zoom);
  $<HTMLElement>('of').textContent = texts.of;
}

function fitScale(): number {
  const first = slots[0];
  if (!first) return 1;
  const available = scroller.clientWidth - 32;
  return Math.max(0.25, Math.min(4, available / first.width));
}

/** Page la plus visible (celle dont le haut est le plus proche du haut de la zone). */
function currentPage(): number {
  const top = scroller.scrollTop;
  let best = 1;
  for (const slot of slots) {
    if (slot.element.offsetTop - 8 <= top + scroller.clientHeight / 3) best = slot.n;
    else break;
  }
  return best;
}

function goTo(n: number): void {
  const slot = slots[Math.min(Math.max(n, 1), slots.length) - 1];
  if (slot) scroller.scrollTop = slot.element.offsetTop - 8;
  updatePageControls();
}

function updatePageControls(): void {
  const n = currentPage();
  if (document.activeElement !== pageInput) pageInput.value = String(n);
  $<HTMLButtonElement>('prev').disabled = n <= 1;
  $<HTMLButtonElement>('next').disabled = n >= slots.length;
}

/** Applique le zoom en gardant la page courante à l'écran. */
function setScale(next: number, fit = false): void {
  const page = currentPage();
  const slot = slots[page - 1];
  const offset = slot ? (scroller.scrollTop - slot.element.offsetTop) / (slot.height * scale) : 0;
  fitWidth = fit;
  scale = fit ? fitScale() : Math.max(0.25, Math.min(4, next));
  zoomLabel.textContent = `${Math.round(scale * 100)} %`;
  for (const s of slots) {
    s.element.style.width = `${Math.floor(s.width * scale)}px`;
    s.element.style.height = `${Math.floor(s.height * scale)}px`;
  }
  if (slot) scroller.scrollTop = slot.element.offsetTop + offset * slot.height * scale;
  renderVisible();
  updatePageControls();
}

function zoomBy(direction: 1 | -1): void {
  const steps = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
  const next = steps.find((z) => (direction > 0 ? z > scale + 0.001 : z < scale - 0.001));
  setScale(next ?? scale);
}

async function renderSlot(slot: Slot): Promise<void> {
  if (!pdf || slot.rendered === scale) return;
  slot.task?.cancel();
  const target = scale;
  const page = await pdf.getPage(slot.n);
  if (target !== scale) return;
  let ratio = Math.min(window.devicePixelRatio || 1, 2);
  const viewportCss = page.getViewport({ scale: target });
  const pixels = viewportCss.width * viewportCss.height * ratio * ratio;
  if (pixels > MAX_CANVAS_PIXELS) ratio *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
  const viewport = page.getViewport({ scale: target * ratio });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', texts.pageLabel(slot.n, pdf.numPages));
  const task = page.render({ canvas, viewport });
  slot.task = task;
  try {
    await task.promise;
  } catch {
    return; // Rendu annulé (nouveau zoom) : un autre rendu suivra.
  }
  if (target !== scale) return;
  slot.element.replaceChildren(canvas);
  slot.rendered = target;
  slot.task = null;
}

/** Dessine les pages visibles (et leurs voisines immédiates). */
function renderVisible(): void {
  const top = scroller.scrollTop - scroller.clientHeight;
  const bottom = scroller.scrollTop + scroller.clientHeight * 2;
  for (const slot of slots) {
    const y = slot.element.offsetTop;
    if (y + slot.element.offsetHeight >= top && y <= bottom) void renderSlot(slot);
  }
}

async function open(data: ArrayBuffer): Promise<void> {
  pdf = await getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    enableXfa: false,
    useSystemFonts: false,
    stopAtErrors: false,
  }).promise;
  const count = Math.min(pdf.numPages, MAX_PAGES);
  for (let n = 1; n <= count; n++) {
    const viewport = (await pdf.getPage(n)).getViewport({ scale: 1 });
    const element = document.createElement('div');
    element.className = 'page';
    element.dataset.page = String(n);
    scroller.append(element);
    slots.push({
      n,
      element,
      width: viewport.width,
      height: viewport.height,
      rendered: null,
      task: null,
    });
  }
  if (pdf.numPages > count) {
    const more = document.createElement('p');
    more.textContent = texts.more(pdf.numPages - count);
    scroller.append(more);
  }
  status.hidden = true;
  toolbar.hidden = false;
  pageInput.max = String(count);
  pageCount.textContent = String(count);
  setScale(1, true);
  // Les pages n'avaient pas encore de taille : repartir du début du document.
  scroller.scrollTop = 0;
  renderVisible();
  updatePageControls();
}

// ---------- Commandes ----------

$<HTMLButtonElement>('prev').addEventListener('click', () => goTo(currentPage() - 1));
$<HTMLButtonElement>('next').addEventListener('click', () => goTo(currentPage() + 1));
$<HTMLButtonElement>('zoom-in').addEventListener('click', () => zoomBy(1));
$<HTMLButtonElement>('zoom-out').addEventListener('click', () => zoomBy(-1));
$<HTMLButtonElement>('fit').addEventListener('click', () => setScale(1, true));
// Pas de <form> : l'iframe n'a pas « allow-forms », l'envoi d'un formulaire y est bloqué.
function submitPage(): void {
  const n = Number.parseInt(pageInput.value, 10);
  if (Number.isFinite(n)) goTo(n);
}
pageInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  submitPage();
  pageInput.select();
});
pageInput.addEventListener('change', submitPage);
pageInput.addEventListener('blur', updatePageControls);

let frame = 0;
scroller.addEventListener('scroll', () => {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    renderVisible();
    updatePageControls();
  });
});

window.addEventListener('resize', () => {
  if (fitWidth && slots.length > 0) setScale(1, true);
});

window.addEventListener('keydown', (event) => {
  if (slots.length === 0 || event.target === pageInput) return;
  if (event.key === '+' || event.key === '=') zoomBy(1);
  else if (event.key === '-') zoomBy(-1);
  else if (event.key === '0') setScale(1, true);
  else return;
  event.preventDefault();
});

scroller.addEventListener(
  'wheel',
  (event) => {
    if (!event.ctrlKey || slots.length === 0) return;
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1 : -1);
  },
  { passive: false },
);

// ---------- Réception du document ----------

let received = false;
window.addEventListener('message', (event: MessageEvent) => {
  // Seul le document parent peut fournir le contenu, une seule fois.
  if (received || event.source !== window.parent) return;
  const data: unknown = event.data;
  if (
    !data ||
    typeof data !== 'object' ||
    (data as { type?: unknown }).type !== 'plume:pdf' ||
    !((data as { bytes?: unknown }).bytes instanceof ArrayBuffer)
  ) {
    return;
  }
  const bytes = (data as { bytes: ArrayBuffer }).bytes;
  if (bytes.byteLength > MAX_BYTES) return;
  received = true;
  texts = (data as { lang?: unknown }).lang === 'en' ? TEXTS.en : TEXTS.fr;
  applyTexts();
  status.textContent = texts.loading;
  open(bytes).catch(() => {
    status.hidden = false;
    status.textContent = texts.failed;
  });
});

applyTexts();
// Signale au parent que la visionneuse est prête (origine cible : le parent, qui vérifie la source).
window.parent.postMessage({ type: 'plume:pdf-ready' }, '*');
