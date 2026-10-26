import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  deletePdf,
  getAllPdfs,
  getLatestPdf,
  getPdfBySlugOrId,
  savePdf,
  slugify,
  type StoredPdf,
} from './db';
import './style.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const SESSION_KEY = 'sleeping-reader:session';
const LEGACY_SESSION_KEY = 'sleep-pdf:session';
const PAGE_GAP = 28;
const PAGE_PADDING = 56;

type ReadingMode = 'horizontal' | 'vertical';

interface SessionState {
  id: string;
  name: string;
  ratio: number;
  speed: number;
  dim: number;
  warm: boolean;
  rotation: number;
  direction: number;
  mode: ReadingMode;
  updatedAt: number;
}

const $ = <T extends HTMLElement>(selector: string): T =>
  document.querySelector(selector) as T;

const viewer = $('#viewer');
const pagesEl = $('#pages');
const emptyEl = $('#empty');
const fileInput = $('#file') as HTMLInputElement;
const docBadge = $('#doc-badge') as HTMLButtonElement;
const docBadgeText = $('#doc-badge-text') as HTMLElement;
const libraryBtn = $('#library-btn') as HTMLButtonElement;
const libraryBackdrop = $('#library-backdrop');
const libraryDrawer = $('#library-drawer');
const libraryClose = $('#library-close') as HTMLButtonElement;
const librarySearch = $('#library-search') as HTMLInputElement;
const libraryList = $('#library-list');
const libraryEmpty = $('#library-empty');
const libraryCount = $('#library-count');
const libraryUpload = $('#library-upload') as HTMLButtonElement;
const emptyRecent = $('#empty-recent');
const emptyRecentList = $('#empty-recent-list');
const playBtn = $('#play') as HTMLButtonElement;
const openBtn = $('#open') as HTMLButtonElement;
const pickBtn = $('#pick') as HTMLButtonElement;
const speedInput = $('#speed') as HTMLInputElement;
const speedOut = $('#speed-out') as HTMLOutputElement;
const dimInput = $('#dim') as HTMLInputElement;
const warmBtn = $('#warm') as HTMLButtonElement;
const rotateBtn = $('#rotate') as HTMLButtonElement;
const directionBtn = $('#direction') as HTMLButtonElement;
const modeBtn = $('#mode') as HTMLButtonElement;
const fullBtn = $('#fullscreen') as HTMLButtonElement;
const pageIndicator = $('#page-indicator') as HTMLButtonElement;
const gotoForm = $('#goto') as HTMLFormElement;
const gotoInput = $('#goto-input') as HTMLInputElement;
const gotoTotal = $('#goto-total') as HTMLElement;
const toastEl = $('#toast');
const dropHint = $('#drop-hint');

const PLAY_ICON =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.5 5.6c0-.8.9-1.3 1.6-.9l8.2 5.5c.6.4.6 1.3 0 1.7l-8.2 5.5c-.7.4-1.6-.1-1.6-.9V5.6Z"/></svg>';
const PAUSE_ICON =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.2"/></svg>';
const EXPAND_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const COMPRESS_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';
const MODE_HORIZONTAL_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="8" height="14" rx="1.5"/><rect x="13" y="5" width="8" height="14" rx="1.5"/></svg>';
const MODE_VERTICAL_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="3" width="14" height="8" rx="1.5"/><rect x="5" y="13" width="14" height="8" rx="1.5"/></svg>';

let pdf: PDFDocumentProxy | null = null;
let docId = '';
let docName = '';
let pageCount = 0;
let baseAspect = 0.7071;
let rotation = 0;
let direction: 1 | -1 = -1;
let readingMode: ReadingMode = 'horizontal';
let pageWrappers: HTMLElement[] = [];
let currentPage = 1;

let speed = 12;
let dim = 35;
let warm = true;
let playing = false;

let raf = 0;
let lastTs = 0;
let scrollPos = 0;
let renderEpoch = 0;
let openToken = 0;
let activeRenders = 0;
let renderQueue: number[] = [];
let observer: IntersectionObserver | null = null;
let saveTimer = 0;
let idleTimer = 0;
let toastTimer = 0;
let scrollRaf = 0;
let resizeTimer = 0;
let wakeLock: WakeLockSentinel | null = null;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function skeleton(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'page-skeleton';
  return el;
}

function getSessionKey(id: string): string {
  return `${SESSION_KEY}:${id}`;
}

function readSession(forId?: string): SessionState | null {
  try {
    const targetId = forId || docId;
    let raw = targetId ? localStorage.getItem(getSessionKey(targetId)) : null;
    if (!raw && targetId) {
      raw = localStorage.getItem(`sleep-pdf:session:${targetId}`);
    }
    if (!raw) {
      raw = localStorage.getItem(SESSION_KEY) || localStorage.getItem(LEGACY_SESSION_KEY);
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionState;
    if (!parsed || typeof parsed.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function scrollOffset(): number {
  return readingMode === 'vertical' ? viewer.scrollTop : viewer.scrollLeft;
}

function scrollMax(): number {
  return readingMode === 'vertical'
    ? viewer.scrollHeight - viewer.clientHeight
    : viewer.scrollWidth - viewer.clientWidth;
}

function setScrollOffset(value: number): void {
  if (readingMode === 'vertical') viewer.scrollTop = value;
  else viewer.scrollLeft = value;
}

function saveSession(): void {
  if (!docId) return;
  const max = scrollMax();
  const state: SessionState = {
    id: docId,
    name: docName,
    ratio: max > 0 ? clamp(scrollOffset() / max, 0, 1) : 0,
    speed,
    dim,
    warm,
    rotation,
    direction,
    mode: readingMode,
    updatedAt: Date.now(),
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(state));
    localStorage.setItem(getSessionKey(docId), JSON.stringify(state));
  } catch {
    // Storage can be full or blocked; reading still works.
  }
}

function saveSessionSoon(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveSession, 800);
}

function hashId(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function showToast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2800);
}

function setVisuals(): void {
  speedInput.value = String(speed);
  speedOut.textContent = `${speed % 1 === 0 ? speed : speed.toFixed(1)} px/s`;
  dimInput.value = String(dim);
  document.documentElement.style.setProperty(
    '--page-brightness',
    String(1 - dim / 100),
  );
  document.documentElement.style.setProperty('--warm-sepia', warm ? '0.22' : '0');
  warmBtn.setAttribute('aria-pressed', String(warm));
}

function setSpeed(next: number, announce = false): void {
  speed = clamp(Math.round(next * 2) / 2, 1, 60);
  setVisuals();
  saveSessionSoon();
  if (announce) showToast(`${speed % 1 === 0 ? speed : speed.toFixed(1)} px/s`);
}

function setDim(next: number): void {
  dim = clamp(Math.round(next), 0, 90);
  setVisuals();
  saveSessionSoon();
}

function setPlaying(next: boolean): void {
  if (next && (!pdf || pageCount === 0)) return;
  if (playing === next) return;
  playing = next;

  playBtn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  playBtn.title = playing ? 'Pause (Space)' : 'Play (Space)';
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  document.body.classList.toggle('playing', playing);

  if (playing) {
    lastTs = 0;
    scrollPos = scrollOffset();
    raf = requestAnimationFrame(tick);
    void requestWakeLock();
    wakeChrome();
  } else {
    cancelAnimationFrame(raf);
    raf = 0;
    void releaseWakeLock();
    document.body.classList.remove('idle');
    saveSession();
  }
}

function tick(timestamp: number): void {
  if (!playing) return;
  if (!lastTs) lastTs = timestamp;
  const dt = Math.min(0.12, (timestamp - lastTs) / 1000);
  lastTs = timestamp;

  const max = scrollMax();
  if (max <= 0) {
    raf = requestAnimationFrame(tick);
    return;
  }

  // In vertical mode, always scroll downward (positive direction).
  const scrollDir = readingMode === 'vertical' ? 1 : direction;
  scrollPos = clamp(scrollPos + scrollDir * speed * dt, 0, max);
  setScrollOffset(scrollPos);

  const atEnd =
    scrollDir === 1 ? scrollPos >= max - 0.25 : scrollPos <= 0.25;
  if (atEnd) {
    setScrollOffset(scrollDir === 1 ? max : 0);
    setPlaying(false);
    showToast('End of document');
    return;
  }

  raf = requestAnimationFrame(tick);
}

async function requestWakeLock(): Promise<void> {
  if (!('wakeLock' in navigator)) return;
  try {
    if (!wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch {
    // Not critical; the screen may dim while reading.
  }
}

async function releaseWakeLock(): Promise<void> {
  if (!wakeLock) return;
  try {
    await wakeLock.release();
  } catch {
    // Already released.
  }
  wakeLock = null;
}

function wakeChrome(): void {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    if (playing) document.body.classList.add('idle');
  }, 2600);
}

function displayAspect(): number {
  return rotation % 180 === 0 ? baseAspect : 1 / baseAspect;
}

function layoutPages(): void {
  if (readingMode === 'vertical') {
    const width = Math.max(200, Math.min(viewer.clientWidth - PAGE_PADDING * 2, 900));
    const height = Math.round(width / displayAspect());
    pagesEl.style.setProperty('--page-w', `${width}px`);
    pagesEl.style.setProperty('--page-h', `${height}px`);
  } else {
    const height = Math.max(200, viewer.clientHeight - PAGE_PADDING);
    const width = Math.round(height * displayAspect());
    pagesEl.style.setProperty('--page-h', `${height}px`);
    pagesEl.style.setProperty('--page-w', `${width}px`);
  }
}

function buildPages(): void {
  pagesEl.replaceChildren();
  pageWrappers = [];
  for (let i = 0; i < pageCount; i += 1) {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.index = String(i);
    el.dataset.state = 'idle';
    el.appendChild(skeleton());
    pagesEl.appendChild(el);
    pageWrappers.push(el);
  }
}

function observePages(): void {
  observer?.disconnect();
  const margin = readingMode === 'vertical' ? '100% 90%' : '90% 100%';
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const index = Number(el.dataset.index);
        if (entry.isIntersecting) {
          scheduleRender(index);
        } else if (entry.intersectionRatio === 0) {
          unloadPage(el);
        }
      }
    },
    {
      root: viewer,
      rootMargin: margin,
      threshold: [0, 0.001],
    },
  );
  for (const el of pageWrappers) observer.observe(el);
}

function scheduleRender(index: number): void {
  const el = pageWrappers[index];
  if (!el || el.dataset.state !== 'idle') return;
  el.dataset.state = 'queued';
  renderQueue.push(index);
  pumpRenders();
}

function pumpRenders(): void {
  while (activeRenders < 2 && renderQueue.length > 0) {
    const index = renderQueue.shift();
    if (index === undefined) break;
    activeRenders += 1;
    void renderPage(index).finally(() => {
      activeRenders -= 1;
      pumpRenders();
    });
  }
}

async function renderPage(index: number): Promise<void> {
  const el = pageWrappers[index];
  if (!el || !pdf || el.dataset.state !== 'queued') return;
  el.dataset.state = 'rendering';
  const epoch = renderEpoch;

  try {
    const page = await pdf.getPage(index + 1);
    if (!el.isConnected || el.dataset.state !== 'rendering') return;

    const rect = el.getBoundingClientRect();
    if (rect.height < 20) {
      el.dataset.state = 'idle';
      return;
    }

    const pageRotation = (page.rotate + rotation) % 360;
    const base = page.getViewport({ scale: 1, rotation: pageRotation });
    const cssScale = rect.height / base.height;
    const renderedWidth = Math.round(base.width * cssScale);
    if (Math.abs(renderedWidth - rect.width) > 2) {
      // Mixed-size documents: let this page keep its own proportions.
      el.style.width = `${renderedWidth}px`;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({
      scale: cssScale * dpr,
      rotation: pageRotation,
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    canvas.style.width = '100%';
    canvas.style.height = '100%';

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas is unavailable');

    await page.render({
      canvasContext: ctx,
      viewport,
      background: 'white',
    }).promise;

    if (!el.isConnected || epoch !== renderEpoch || el.dataset.state !== 'rendering') {
      return;
    }

    const vr = viewer.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const farAway = readingMode === 'vertical'
      ? r.bottom < vr.top - vr.height * 1.6 || r.top > vr.bottom + vr.height * 1.6
      : r.right < vr.left - vr.width * 1.6 || r.left > vr.right + vr.width * 1.6;

    el.replaceChildren(canvas);
    el.dataset.state = 'ready';
    if (farAway) unloadPage(el);
  } catch {
    if (el.isConnected) {
      el.dataset.state = 'idle';
    }
  }
}

function unloadPage(el: HTMLElement): void {
  if (el.dataset.state !== 'ready') return;
  el.replaceChildren(skeleton());
  el.dataset.state = 'idle';
}

function pageAtCenter(): number {
  if (pageWrappers.length === 0) return 0;
  const first = pageWrappers[0];
  const second = pageWrappers[1];

  if (readingMode === 'vertical') {
    const step = second
      ? second.offsetTop - first.offsetTop
      : first.offsetHeight + PAGE_GAP;
    const center = viewer.scrollTop + viewer.clientHeight / 2;
    const index = Math.round(
      (center - first.offsetTop - first.offsetHeight / 2) / step,
    );
    return clamp(index, 0, pageWrappers.length - 1);
  }

  const step = second
    ? second.offsetLeft - first.offsetLeft
    : first.offsetWidth + PAGE_GAP;
  const center = viewer.scrollLeft + viewer.clientWidth / 2;
  const index = Math.round(
    (center - first.offsetLeft - first.offsetWidth / 2) / step,
  );
  return clamp(index, 0, pageWrappers.length - 1);
}

function centerPage(index: number): void {
  const el = pageWrappers[index];
  if (!el) return;

  if (readingMode === 'vertical') {
    const max = viewer.scrollHeight - viewer.clientHeight;
    const target = el.offsetTop + el.offsetHeight / 2 - viewer.clientHeight / 2;
    viewer.scrollTop = clamp(target, 0, Math.max(0, max));
    scrollPos = viewer.scrollTop;
  } else {
    const max = viewer.scrollWidth - viewer.clientWidth;
    const target = el.offsetLeft + el.offsetWidth / 2 - viewer.clientWidth / 2;
    viewer.scrollLeft = clamp(target, 0, Math.max(0, max));
    scrollPos = viewer.scrollLeft;
  }
}

function updatePageIndicator(): void {
  if (pageWrappers.length === 0) {
    pageIndicator.textContent = '–';
    return;
  }
  currentPage = pageAtCenter() + 1;
  pageIndicator.textContent = `${currentPage} / ${pageCount}`;
}

function openGoto(): void {
  if (!pdf || pageCount === 0) return;
  setPlaying(false);
  wakeChrome();
  gotoTotal.textContent = `/ ${pageCount}`;
  gotoInput.value = String(pageAtCenter() + 1);
  gotoForm.hidden = false;
  gotoInput.focus();
  gotoInput.select();
}

function closeGoto(): void {
  if (gotoForm.hidden) return;
  gotoForm.hidden = true;
  gotoInput.blur();
}

function jumpToPage(pageNumber: number): void {
  if (!pdf || pageCount === 0) return;
  const index = clamp(Math.round(pageNumber) - 1, 0, pageCount - 1);
  centerPage(index);
  updatePageIndicator();
  saveSession();
  closeGoto();
  showToast(`Page ${index + 1} of ${pageCount}`);
}

function updateRotationButton(): void {
  rotateBtn.setAttribute('aria-pressed', String(rotation !== 0));
  rotateBtn.title =
    rotation === 0 ? 'Rotate pages (R)' : `Rotate pages · ${rotation}° (R)`;
  rotateBtn.setAttribute(
    'aria-label',
    rotation === 0
      ? 'Rotate pages'
      : `Rotate pages, currently ${rotation} degrees`,
  );
}

function updateDirectionButton(): void {
  directionBtn.setAttribute('aria-pressed', String(direction === -1));
  directionBtn.title =
    direction === -1 ? 'Pages drift right (D)' : 'Pages drift left (D)';
  directionBtn.setAttribute(
    'aria-label',
    direction === -1
      ? 'Pages drift right, next page enters from the left'
      : 'Pages drift left, next page enters from the right',
  );
}

function toggleDirection(): void {
  if (!pdf) return;
  const anchor = pageAtCenter();
  direction = direction === 1 ? -1 : 1;
  pagesEl.classList.toggle('rtl', direction === -1);
  updateDirectionButton();
  centerPage(anchor);
  updatePageIndicator();
  saveSession();
  showToast(direction === -1 ? 'Pages drift right' : 'Pages drift left');
}

function updateModeButton(): void {
  const isVertical = readingMode === 'vertical';
  modeBtn.innerHTML = isVertical ? MODE_HORIZONTAL_ICON : MODE_VERTICAL_ICON;
  modeBtn.setAttribute('aria-pressed', String(isVertical));
  modeBtn.title = isVertical ? 'Horizontal reading (V)' : 'Vertical reading (V)';
  modeBtn.setAttribute(
    'aria-label',
    isVertical ? 'Switch to horizontal reading' : 'Switch to vertical reading',
  );
}

function applyMode(): void {
  document.body.classList.toggle('vertical', readingMode === 'vertical');
  updateModeButton();
}

function toggleMode(): void {
  if (!pdf) return;
  setPlaying(false);
  const anchor = pageAtCenter();

  readingMode = readingMode === 'horizontal' ? 'vertical' : 'horizontal';
  applyMode();

  // Detach and re-observe with correct rootMargin for the new axis
  observer?.disconnect();
  observer = null;
  renderQueue = [];
  for (const el of pageWrappers) {
    el.dataset.state = 'idle';
    el.style.width = '';
    el.replaceChildren(skeleton());
  }
  renderEpoch += 1;

  layoutPages();
  observePages();

  requestAnimationFrame(() => {
    centerPage(anchor);
    updatePageIndicator();
    saveSession();
  });

  showToast(readingMode === 'vertical' ? 'Vertical reading' : 'Horizontal reading');
}

function rotatePages(step = 90): void {
  if (!pdf) return;
  const anchor = pageAtCenter();
  rotation = (rotation + step + 360) % 360;
  renderEpoch += 1;
  updateRotationButton();

  observer?.disconnect();
  observer = null;
  renderQueue = [];
  for (const el of pageWrappers) {
    el.dataset.state = 'idle';
    el.style.width = '';
    el.replaceChildren(skeleton());
  }

  layoutPages();
  observePages();

  requestAnimationFrame(() => {
    centerPage(anchor);
    updatePageIndicator();
    saveSession();
  });

  const labels: Record<number, string> = {
    0: 'Pages upright',
    90: 'Sideways · 90°',
    180: 'Upside down · 180°',
    270: 'Sideways · 270°',
  };
  showToast(labels[rotation] ?? `${rotation}°`);
}

function updateUrl(slug: string, replace = false): void {
  const path = `/${encodeURIComponent(slug)}`;
  if (window.location.pathname === path) return;
  if (replace) {
    window.history.replaceState({ id: docId, slug }, '', path);
  } else {
    window.history.pushState({ id: docId, slug }, '', path);
  }
}

function resetUrl(): void {
  if (window.location.pathname !== '/') {
    window.history.pushState(null, '', '/');
  }
}

let allLibraryPdfs: StoredPdf[] = [];
let libraryOpen = false;

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderLibraryList(filter = ''): void {
  const q = filter.trim().toLowerCase();
  const filtered = allLibraryPdfs.filter(
    (item) =>
      !q ||
      item.name.toLowerCase().includes(q) ||
      (item.slug && item.slug.toLowerCase().includes(q)),
  );

  libraryCount.textContent = `${allLibraryPdfs.length} ${allLibraryPdfs.length === 1 ? 'book' : 'books'}`;
  libraryEmpty.hidden = filtered.length > 0;
  libraryList.replaceChildren();

  for (const item of filtered) {
    const isCurrent = item.id === docId;
    const el = document.createElement('div');
    el.className = `library-item${isCurrent ? ' active' : ''}`;
    el.setAttribute('role', 'listitem');

    const content = document.createElement('div');
    content.className = 'library-item-content';

    const icon = document.createElement('div');
    icon.className = 'library-item-icon';
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 6h10M6 10h10"/></svg>`;

    const info = document.createElement('div');
    info.className = 'library-item-info';

    const title = document.createElement('div');
    title.className = 'library-item-title';
    title.textContent = item.name;
    title.title = item.name;

    const meta = document.createElement('div');
    meta.className = 'library-item-meta';

    const time = document.createElement('span');
    time.textContent = formatRelativeTime(item.updatedAt);
    meta.appendChild(time);

    if (item.bytes?.byteLength) {
      const sep = document.createElement('span');
      sep.textContent = '·';
      const size = document.createElement('span');
      size.textContent = formatBytes(item.bytes.byteLength);
      meta.appendChild(sep);
      meta.appendChild(size);
    }

    if (isCurrent) {
      const badge = document.createElement('span');
      badge.className = 'library-item-active-badge';
      badge.textContent = 'Reading';
      meta.appendChild(badge);
    }

    info.appendChild(title);
    info.appendChild(meta);
    content.appendChild(icon);
    content.appendChild(info);

    content.addEventListener('click', () => {
      closeLibrary();
      if (item.id === docId) return;
      void openBytes(item.bytes, item.name, item.id, { persist: false });
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'library-item-delete';
    delBtn.type = 'button';
    delBtn.title = `Remove “${item.name}” from library`;
    delBtn.setAttribute('aria-label', `Remove ${item.name}`);
    delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deletePdf(item.id);
      allLibraryPdfs = allLibraryPdfs.filter((p) => p.id !== item.id);
      renderLibraryList(librarySearch.value);
      void renderRecentBooks();
      showToast(`Removed “${item.name}”`);
      if (item.id === docId) {
        resetReader();
        resetUrl();
        emptyEl.hidden = false;
      }
    });

    el.appendChild(content);
    el.appendChild(delBtn);
    libraryList.appendChild(el);
  }
}

async function renderRecentBooks(): Promise<void> {
  const books = await getAllPdfs().catch(() => []);
  if (books.length === 0) {
    emptyRecent.hidden = true;
    return;
  }
  emptyRecent.hidden = false;
  emptyRecentList.replaceChildren();

  for (const book of books.slice(0, 3)) {
    const card = document.createElement('div');
    card.className = 'recent-card';

    const info = document.createElement('div');
    info.className = 'recent-card-info';

    const icon = document.createElement('div');
    icon.className = 'recent-card-icon';
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/></svg>`;

    const name = document.createElement('div');
    name.className = 'recent-card-name';
    name.textContent = book.name;

    info.appendChild(icon);
    info.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'recent-card-meta';
    meta.textContent = formatRelativeTime(book.updatedAt);

    card.appendChild(info);
    card.appendChild(meta);

    card.addEventListener('click', () => {
      void openBytes(book.bytes, book.name, book.id, { persist: false });
    });

    emptyRecentList.appendChild(card);
  }
}

async function openLibrary(): Promise<void> {
  if (playing) setPlaying(false);
  wakeChrome();
  libraryOpen = true;
  libraryBackdrop.hidden = false;
  libraryDrawer.hidden = false;
  requestAnimationFrame(() => {
    libraryBackdrop.classList.add('show');
    libraryDrawer.classList.add('show');
  });
  librarySearch.value = '';
  allLibraryPdfs = await getAllPdfs().catch(() => []);
  renderLibraryList();
  librarySearch.focus();
}

function closeLibrary(): void {
  if (!libraryOpen && libraryDrawer.hidden) return;
  libraryOpen = false;
  librarySearch.blur();
  libraryBackdrop.classList.remove('show');
  libraryDrawer.classList.remove('show');
  window.setTimeout(() => {
    if (!libraryOpen) {
      libraryBackdrop.hidden = true;
      libraryDrawer.hidden = true;
    }
  }, 280);
}

function toggleLibrary(): void {
  if (libraryOpen) closeLibrary();
  else void openLibrary();
}

function updateDocBadge(): void {
  docBadgeText.textContent = docName;
  docBadge.title = docName ? `“${docName}” · Open Library (L)` : 'Open Library (L)';
  docBadge.setAttribute(
    'aria-label',
    docName ? `Book: ${docName}. Click to open library` : 'Open library',
  );
}

function resetReader(): void {
  setPlaying(false);
  renderEpoch += 1;
  observer?.disconnect();
  observer = null;
  renderQueue = [];
  activeRenders = 0;
  pagesEl.replaceChildren();
  pageWrappers = [];
  pageCount = 0;
  currentPage = 1;
  docId = '';
  docName = '';
  if (pdf) {
    void pdf.destroy().catch(() => undefined);
    pdf = null;
  }
  pageIndicator.textContent = '–';
  updateDocBadge();
  closeGoto();
  document.body.classList.remove('has-doc');
}

async function openBytes(
  bytes: ArrayBuffer,
  name: string,
  id: string,
  options: {
    persist?: boolean;
    restoreRatio?: number;
    replaceUrl?: boolean;
    updateUrl?: boolean;
  } = {},
): Promise<void> {
  const token = ++openToken;
  closeLibrary();
  resetReader();

  try {
    const copy = bytes.slice(0);
    const task = pdfjsLib.getDocument({
      data: bytes,
      cMapUrl: '/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/standard_fonts/',
      useSystemFonts: true,
    });
    const document_ = await task.promise;
    if (token !== openToken) {
      void document_.destroy();
      return;
    }

    pdf = document_;
    docId = id;
    docName = name;
    pageCount = document_.numPages;
    updateDocBadge();

    const slug = slugify(name);
    if (options.updateUrl !== false) {
      updateUrl(slug, options.replaceUrl);
    }

    const firstPage = await document_.getPage(1);
    const viewport = firstPage.getViewport({ scale: 1 });
    baseAspect = viewport.width / viewport.height;
    updateRotationButton();

    buildPages();
    pagesEl.classList.toggle('rtl', direction === -1);
    layoutPages();
    observePages();

    const session = readSession(id);
    if (session && session.id === id) {
      if (Number.isFinite(session.speed)) speed = clamp(session.speed, 1, 60);
      if (Number.isFinite(session.dim)) dim = clamp(session.dim, 0, 90);
      warm = Boolean(session.warm);
      if ([0, 90, 180, 270].includes(session.rotation)) rotation = session.rotation;
      if (session.direction === 1 || session.direction === -1) direction = session.direction;
      if (session.mode === 'vertical' || session.mode === 'horizontal') readingMode = session.mode;
      setVisuals();
      updateRotationButton();
      updateDirectionButton();
      applyMode();
    }

    const fallbackRatio = direction === -1 ? 1 : 0;
    const restoreRatio =
      options.restoreRatio ??
      (session && session.id === id
        ? clamp(session.ratio, 0, 1)
        : fallbackRatio);

    emptyEl.hidden = true;
    document.body.classList.add('has-doc');
    document.title = `${name} · Sleeping Reader`;

    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );

    const max = scrollMax();
    setScrollOffset(restoreRatio * Math.max(0, max));
    updatePageIndicator();
    scheduleRender(0);
    scheduleRender(1);

    if (options.persist !== false) {
      void savePdf({ id, name, slug, bytes: copy, updatedAt: Date.now() }).catch(
        () => undefined,
      );
    }

    saveSession();
    void renderRecentBooks();
    showToast(
      restoreRatio > 0.01 ? `Resumed “${name}”` : `Opened “${name}”`,
    );
    firstPage.cleanup();
  } catch (error) {
    if (token !== openToken) return;
    console.error(error);
    resetReader();
    resetUrl();
    emptyEl.hidden = false;
    void renderRecentBooks();
    showToast('Could not open that PDF');
  }
}

async function openFile(file: File): Promise<void> {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    showToast('Please choose a PDF');
    return;
  }
  const id = hashId(`${file.name}:${file.size}:${file.lastModified}`);
  const bytes = await file.arrayBuffer();
  await openBytes(bytes, file.name, id, { persist: true });
}

function togglePlay(): void {
  setPlaying(!playing);
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => undefined);
  } else {
    void document.documentElement.requestFullscreen().catch(() => undefined);
  }
}

function toggleWarm(): void {
  warm = !warm;
  setVisuals();
  saveSessionSoon();
  showToast(warm ? 'Warm light on' : 'Warm light off');
}

function onResize(): void {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (!pdf) return;
    const maxBefore = scrollMax();
    const ratio = maxBefore > 0 ? scrollOffset() / maxBefore : 0;
    layoutPages();
    requestAnimationFrame(() => {
      const max = scrollMax();
      setScrollOffset(ratio * Math.max(0, max));
    });
  }, 180);
}

function bindEvents(): void {
  playBtn.addEventListener('click', togglePlay);
  openBtn.addEventListener('click', () => fileInput.click());
  pickBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void openFile(file);
  });

  speedInput.addEventListener('input', () => {
    setSpeed(Number(speedInput.value));
  });
  speedInput.addEventListener('change', () => {
    saveSession();
    setVisuals();
  });

  dimInput.addEventListener('input', () => setDim(Number(dimInput.value)));
  warmBtn.addEventListener('click', toggleWarm);
  rotateBtn.addEventListener('click', () => rotatePages(90));
  directionBtn.addEventListener('click', toggleDirection);
  modeBtn.addEventListener('click', toggleMode);
  fullBtn.addEventListener('click', toggleFullscreen);

  docBadge.addEventListener('click', toggleLibrary);
  libraryBtn.addEventListener('click', toggleLibrary);
  libraryClose.addEventListener('click', closeLibrary);
  libraryBackdrop.addEventListener('click', closeLibrary);
  libraryUpload.addEventListener('click', () => {
    closeLibrary();
    fileInput.click();
  });
  librarySearch.addEventListener('input', () => {
    renderLibraryList(librarySearch.value);
  });

  pageIndicator.addEventListener('click', () => {
    if (gotoForm.hidden) openGoto();
    else closeGoto();
  });

  gotoForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = Number.parseInt(gotoInput.value, 10);
    if (Number.isFinite(value)) jumpToPage(value);
    else closeGoto();
  });

  gotoInput.addEventListener('input', () => {
    const digits = gotoInput.value.replace(/\D/g, '').slice(0, 5);
    if (digits !== gotoInput.value) gotoInput.value = digits;
  });

  gotoInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeGoto();
    }
  });

  document.addEventListener('pointerdown', (event) => {
    if (gotoForm.hidden) return;
    const target = event.target as Node;
    if (gotoForm.contains(target) || pageIndicator.contains(target)) return;
    closeGoto();
  });

  viewer.addEventListener(
    'wheel',
    () => {
      if (playing) setPlaying(false);
    },
    { passive: true },
  );

  viewer.addEventListener('click', () => {
    if (!pdf) return;
    // In vertical mode, don't toggle play on click (interferes with scrolling)
    if (readingMode === 'vertical') return;
    togglePlay();
  });

  viewer.addEventListener(
    'scroll',
    () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        updatePageIndicator();
        saveSessionSoon();
      });
    },
    { passive: true },
  );

  document.addEventListener('mousemove', wakeChrome, { passive: true });
  document.addEventListener('pointerdown', wakeChrome, { passive: true });
  document.addEventListener('keydown', wakeChrome);

  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (event.key === 'Escape') {
        if (libraryOpen) {
          event.preventDefault();
          closeLibrary();
        }
      }
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      fileInput.click();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    switch (event.key) {
      case ' ':
        event.preventDefault();
        if (pdf) togglePlay();
        break;
      case 'ArrowRight':
        event.preventDefault();
        setPlaying(false);
        if (readingMode === 'vertical') {
          viewer.scrollBy({ top: viewer.clientHeight * 0.9, behavior: 'smooth' });
        } else {
          viewer.scrollBy({ left: viewer.clientWidth * 0.9, behavior: 'smooth' });
        }
        break;
      case 'ArrowLeft':
        event.preventDefault();
        setPlaying(false);
        if (readingMode === 'vertical') {
          viewer.scrollBy({ top: -viewer.clientHeight * 0.9, behavior: 'smooth' });
        } else {
          viewer.scrollBy({ left: -viewer.clientWidth * 0.9, behavior: 'smooth' });
        }
        break;
      case 'ArrowUp':
        event.preventDefault();
        setSpeed(speed + 1, true);
        break;
      case 'ArrowDown':
        event.preventDefault();
        setSpeed(speed - 1, true);
        break;
      case 'f':
      case 'F':
        event.preventDefault();
        toggleFullscreen();
        break;
      case 'l':
      case 'L':
        event.preventDefault();
        toggleLibrary();
        break;
      case 'Escape':
        if (libraryOpen) {
          event.preventDefault();
          closeLibrary();
        }
        break;
      case 'n':
      case 'N':
        event.preventDefault();
        toggleWarm();
        break;
      case 'r':
      case 'R':
        event.preventDefault();
        rotatePages(event.shiftKey ? -90 : 90);
        break;
      case 'd':
      case 'D':
        event.preventDefault();
        toggleDirection();
        break;
      case 'v':
      case 'V':
        event.preventDefault();
        toggleMode();
        break;
      case 'g':
      case 'G':
        event.preventDefault();
        if (gotoForm.hidden) openGoto();
        else closeGoto();
        break;
      case 'o':
      case 'O':
        event.preventDefault();
        fileInput.click();
        break;
      default:
        break;
    }
  });

  document.addEventListener('fullscreenchange', () => {
    fullBtn.innerHTML = document.fullscreenElement ? COMPRESS_ICON : EXPAND_ICON;
    fullBtn.title = document.fullscreenElement ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
    fullBtn.setAttribute(
      'aria-label',
      document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen',
    );
  });

  window.addEventListener('popstate', async () => {
    const slug = decodeURIComponent(window.location.pathname.replace(/^\/+/, '')).trim();
    if (!slug) {
      resetReader();
      emptyEl.hidden = false;
      void renderRecentBooks();
      return;
    }
    if (pdf && (docId === slug || slugify(docName) === slug)) {
      return;
    }
    const match = await getPdfBySlugOrId(slug);
    if (match) {
      await openBytes(match.bytes, match.name, match.id, {
        persist: false,
        updateUrl: false,
      });
    } else {
      showToast(`“${slug}” not found in library`);
      resetUrl();
    }
  });

  const hasFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files');

  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    if (event.relatedTarget === null) {
      document.body.classList.remove('dragging');
    }
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    document.body.classList.remove('dragging');
    const file = event.dataTransfer?.files?.[0];
    if (file) void openFile(file);
  });

  window.addEventListener('resize', onResize);
  window.addEventListener('pagehide', saveSession);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveSession();
    } else if (playing) {
      void requestWakeLock();
    }
  });

  dropHint.setAttribute('aria-hidden', 'true');
}

async function init(): Promise<void> {
  const session = readSession();
  if (session) {
    if (Number.isFinite(session.speed)) speed = clamp(session.speed, 1, 60);
    if (Number.isFinite(session.dim)) dim = clamp(session.dim, 0, 90);
    warm = Boolean(session.warm);
    rotation = [0, 90, 180, 270].includes(session.rotation)
      ? session.rotation
      : 0;
    direction = session.direction === 1 ? 1 : -1;
    if (session.mode === 'vertical') readingMode = 'vertical';
  }

  setVisuals();
  playBtn.innerHTML = PLAY_ICON;
  fullBtn.innerHTML = EXPAND_ICON;
  updateRotationButton();
  updateDirectionButton();
  applyMode();
  bindEvents();

  // Check URL pathname for a book slug (e.g. /my-book)
  const pathSlug = decodeURIComponent(window.location.pathname.replace(/^\/+/, '')).trim();
  let stored: StoredPdf | null = null;

  if (pathSlug) {
    stored = await getPdfBySlugOrId(pathSlug).catch(() => null);
    if (!stored) {
      showToast(`“${pathSlug}” not found. Loading library...`);
      resetUrl();
    }
  }

  if (!stored) {
    stored = await getLatestPdf().catch(() => null);
  }

  if (stored) {
    const bookSession = readSession(stored.id) ?? session;
    const restoreRatio =
      bookSession && bookSession.id === stored.id
        ? clamp(bookSession.ratio, 0, 1)
        : direction === -1
          ? 1
          : 0;
    await openBytes(stored.bytes, stored.name, stored.id, {
      persist: false,
      restoreRatio,
      replaceUrl: true,
    });
  } else {
    await renderRecentBooks();
  }
}

void init();

// ── PWA: Service Worker ──────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js')
      .catch((err) => console.warn('SW registration failed:', err));
  });
}

// ── PWA: File Handling API (desktop Chrome / Edge) ───────────────────────

if ('launchQueue' in window) {
  (window as any).launchQueue.setConsumer(async (launchParams: any) => {
    if (!launchParams.files?.length) return;
    const handle = launchParams.files[0];
    const file: File = await handle.getFile();
    void openFile(file);
  });
}
