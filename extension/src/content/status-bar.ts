/**
 * Trimly - Status Bar
 * Compact floating pill indicator showing trimming statistics
 */

import { TIMING } from '../shared/constants';
import browser from '../shared/browser-polyfill';

const STATUS_BAR_ID = 'trimly-status-bar';
const STATUS_BAR_STYLE_ID = 'trimly-status-style';
const STATUS_LOGO_URL = browser.runtime.getURL('assets/icons/128x128.png');
const STATUS_HIDDEN_CLASS = 'ls-status-hidden';
const STATUS_TEXT_CLASS = 'ls-status-text';
const STATUS_LOGO_WRAP_CLASS = 'ls-status-logo-wrap';
const SHOW_HIDE_MS = 140;

export interface StatusBarStats {
  totalMessages: number;
  visibleMessages: number;
  trimmedMessages: number;
  keepLastN: number;
}

type StatusBarState = 'active' | 'waiting' | 'all-visible' | 'unrecognized';
type StyleMap = Record<string, string>;

// ----------------------------------------------------------------------------
// Style tokens for quick tuning.
// Edit these values instead of hunting through functions.
// ----------------------------------------------------------------------------
const BAR_BASE_STYLE: StyleMap = {
  position: 'fixed',
  bottom: '20px',
  right: '24px',
  zIndex: '10000',
  padding: '7px 12px',
  fontSize: '11px',
  fontFamily: '"Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  fontWeight: '500',
  color: '#ffffff',
  backgroundColor: 'rgba(0, 0, 0, 0.9)',
  border: '1px solid rgba(255, 255, 255, 0.18)',
  borderRadius: '20px',
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
  backdropFilter: 'blur(4px)',
  maxWidth: '60%',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  pointerEvents: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  opacity: '1',
  transform: 'translateY(0) scale(1)',
  transition:
    'opacity 140ms ease, transform 140ms ease, padding 140ms ease, border-radius 140ms ease, border-color 140ms ease, background-color 140ms ease, box-shadow 140ms ease',
};

const BAR_STATE_BASE_STYLE: StyleMap = {
  color: '#ffffff',
  backgroundColor: 'rgba(0, 0, 0, 0.9)',
  borderColor: 'rgba(255, 255, 255, 0.18)',
  padding: '7px 12px',
  width: 'auto',
  height: 'auto',
  gap: '5px',
  justifyContent: 'flex-start',
};

const BAR_STATE_STYLE: Record<StatusBarState, StyleMap> = {
  active: {
    color: '#ffffff',
    backgroundColor: 'rgba(10, 10, 10, 0.95)',
    borderColor: 'rgba(255, 255, 255, 0.18)',
  },
  waiting: {
    color: '#a3a3a3',
    padding: '0',
    width: '44px',
    height: '44px',
    gap: '0',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: '999px',
  },
  'all-visible': {},
  unrecognized: {
    color: '#e5e5e5',
    backgroundColor: 'rgba(28, 28, 28, 0.95)',
    borderColor: 'rgba(255, 255, 255, 0.24)',
  },
};

let currentStats: StatusBarStats | null = null;
let isVisible = true;

// Throttle status bar updates to reduce DOM writes during active chat
let lastUpdateTime = 0;
let pendingStats: StatusBarStats | null = null;
let pendingUpdateTimer: number | null = null;
let lastRenderedState: StatusBarState | null = null;
let hideTimer: number | null = null;

function applyStyles(el: HTMLElement, styles: StyleMap): void {
  for (const [property, value] of Object.entries(styles)) {
    el.style.setProperty(property.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), value);
  }
}

/**
 * Get or create the status bar element
 */
function getOrCreateStatusBar(): HTMLElement | null {
  let bar = document.getElementById(STATUS_BAR_ID);
  if (bar) {
    return bar;
  }

  bar = document.createElement('div');
  bar.id = STATUS_BAR_ID;
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');

  applyStatusBarStyles(bar);
  ensureStatusBarStyles();

  document.body.appendChild(bar);

  return bar;
}

/**
 * Apply inline styles to the status bar (compact pill, bottom-right)
 */
function applyStatusBarStyles(bar: HTMLElement): void {
  applyStyles(bar, BAR_BASE_STYLE);
}

function ensureStatusBarStyles(): void {
  if (document.getElementById(STATUS_BAR_STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = STATUS_BAR_STYLE_ID;
  style.textContent = `
    #${STATUS_BAR_ID}.${STATUS_HIDDEN_CLASS} {
      opacity: 0 !important;
      transform: translateY(4px) scale(0.98) !important;
      pointer-events: none !important;
    }

    .${STATUS_TEXT_CLASS} {
      display: none;
    }

    .${STATUS_LOGO_WRAP_CLASS} {
      width: 100%;
      height: 100%;
      display: grid;
      place-items: center;
    }

    .ls-status-logo {
      width: 24px;
      height: 24px;
      display: block;
      flex-shrink: 0;
      border-radius: 3px;
      object-fit: contain;
      image-rendering: auto;
      transform: translateZ(0);
    }
  `;
  document.head.appendChild(style);
}

/**
 * Get status bar text based on current state (short format for pill)
 */
function getStatusText(stats: StatusBarStats): { text: string; state: StatusBarState } {
  if (stats.trimmedMessages > 0) {
    return {
      text: `Showing ${stats.visibleMessages} of ${stats.totalMessages} messages`,
      state: 'active',
    };
  }

  if (stats.totalMessages === 0) {
    return {
      text: '',
      state: 'waiting',
    };
  }

  if (stats.totalMessages <= stats.keepLastN) {
    return {
      text: `Showing ${stats.totalMessages} messages`,
      state: 'all-visible',
    };
  }

  return {
    text: `Showing ${stats.visibleMessages} of ${stats.totalMessages} messages`,
    state: 'active',
  };
}

function setBarText(bar: HTMLElement, text: string, state: StatusBarState): void {
  const { textEl, logoWrap } = ensureBarContentNodes(bar);
  if (state === 'waiting') {
    textEl.style.display = 'none';
    logoWrap.style.display = 'grid';
    return;
  }

  if (textEl.textContent !== text) {
    textEl.textContent = text;
  }
  textEl.style.display = 'inline';
  logoWrap.style.display = 'none';
}

function ensureBarContentNodes(bar: HTMLElement): { textEl: HTMLSpanElement; logoWrap: HTMLSpanElement } {
  let textEl = bar.querySelector<HTMLSpanElement>(`.${STATUS_TEXT_CLASS}`);
  let logoWrap = bar.querySelector<HTMLSpanElement>(`.${STATUS_LOGO_WRAP_CLASS}`);

  if (!textEl) {
    textEl = document.createElement('span');
    textEl.className = STATUS_TEXT_CLASS;
    bar.appendChild(textEl);
  }

  if (!logoWrap) {
    logoWrap = document.createElement('span');
    logoWrap.className = STATUS_LOGO_WRAP_CLASS;
    const logo = document.createElement('img');
    logo.className = 'ls-status-logo';
    logo.src = STATUS_LOGO_URL;
    logo.alt = '';
    logo.setAttribute('aria-hidden', 'true');
    logoWrap.appendChild(logo);
    bar.appendChild(logoWrap);
  }

  return { textEl, logoWrap };
}

/**
 * Apply state-specific styling
 */
function applyStateStyles(bar: HTMLElement, state: StatusBarState): void {
  applyStyles(bar, BAR_STATE_BASE_STYLE);
  applyStyles(bar, BAR_STATE_STYLE[state]);
}

/**
 * Check if two stats objects are equal (for change detection)
 */
function statsEqual(a: StatusBarStats | null, b: StatusBarStats | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.totalMessages === b.totalMessages &&
    a.visibleMessages === b.visibleMessages &&
    a.trimmedMessages === b.trimmedMessages &&
    a.keepLastN === b.keepLastN
  );
}

/**
 * Actually render the status bar (internal, bypasses throttle)
 */
function renderStatusBar(displayStats: StatusBarStats): void {
  const bar = getOrCreateStatusBar();
  if (!bar) {
    return;
  }

  const { text, state } = getStatusText(displayStats);
  setBarText(bar, text, state);
  applyStateStyles(bar, state);
  lastRenderedState = state;
  lastUpdateTime = performance.now();
}

function renderWaitingStatusBar(bar: HTMLElement): void {
  setBarText(bar, '', 'waiting');
  applyStateStyles(bar, 'waiting');
  lastRenderedState = 'waiting';
  lastUpdateTime = performance.now();
}

/**
 * Update the status bar with new stats (throttled, with change detection)
 */
export function updateStatusBar(stats: StatusBarStats): void {
  // Page-script reports an absolute "currently hidden" count (not a delta),
  // so the status bar must not accumulate across repeated status events.
  const displayStats: StatusBarStats = stats;

  // Change detection: skip if stats haven't changed
  if (statsEqual(displayStats, currentStats)) {
    return;
  }

  currentStats = displayStats;

  if (!isVisible) {
    return;
  }

  // Throttle: check if enough time has passed since last update
  const now = performance.now();
  const elapsed = now - lastUpdateTime;

  if (elapsed >= TIMING.STATUS_BAR_THROTTLE_MS) {
    // Enough time passed, render immediately
    if (pendingUpdateTimer !== null) {
      clearTimeout(pendingUpdateTimer);
      pendingUpdateTimer = null;
    }
    pendingStats = null;
    renderStatusBar(displayStats);
  } else {
    // Too soon, schedule pending update
    pendingStats = displayStats;
    if (pendingUpdateTimer === null) {
      const delay = TIMING.STATUS_BAR_THROTTLE_MS - elapsed;
      pendingUpdateTimer = window.setTimeout(() => {
        pendingUpdateTimer = null;
        if (pendingStats && isVisible) {
          renderStatusBar(pendingStats);
          pendingStats = null;
        }
      }, delay);
    }
  }
}

/**
 * Show warning when ChatGPT layout is not recognized
 */
export function showLayoutNotRecognized(): void {
  if (!isVisible) {
    return;
  }

  const bar = getOrCreateStatusBar();
  if (!bar) {
    return;
  }

  bar.textContent = 'Messages · layout not recognized';
  applyStateStyles(bar, 'unrecognized');
  lastRenderedState = 'unrecognized';
}

/**
 * Show the status bar
 */
export function showStatusBar(): void {
  isVisible = true;
  const bar = getOrCreateStatusBar();
  if (!bar) {
    return;
  }

  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  const alreadyVisible = bar.style.display !== 'none' && !bar.classList.contains(STATUS_HIDDEN_CLASS);
  bar.style.display = 'inline-flex';
  if (!alreadyVisible) {
    bar.classList.add(STATUS_HIDDEN_CLASS);
    void bar.offsetWidth;
    requestAnimationFrame(() => {
      bar.classList.remove(STATUS_HIDDEN_CLASS);
    });
  }

  if (currentStats) {
    const { text, state } = getStatusText(currentStats);
    setBarText(bar, text, state);
    applyStateStyles(bar, state);
    lastUpdateTime = performance.now();
    return;
  }

  renderWaitingStatusBar(bar);
}

/**
 * Hide the status bar
 */
export function hideStatusBar(): void {
  isVisible = false;
  const bar = document.getElementById(STATUS_BAR_ID);

  if (bar) {
    bar.classList.add(STATUS_HIDDEN_CLASS);
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
    }
    hideTimer = window.setTimeout(() => {
      bar.style.display = 'none';
      hideTimer = null;
    }, SHOW_HIDE_MS);
  }
}

/**
 * Remove the status bar from DOM
 */
export function removeStatusBar(): void {
  // Clear any pending update timer
  if (pendingUpdateTimer !== null) {
    clearTimeout(pendingUpdateTimer);
    pendingUpdateTimer = null;
  }
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  pendingStats = null;

  const bar = document.getElementById(STATUS_BAR_ID);
  if (bar) {
    bar.remove();
  }
  currentStats = null;
  lastRenderedState = null;
  isVisible = false;
  lastUpdateTime = 0;
}

/**
 * Reset status bar state (call on chat navigation / empty chat)
 */
export function resetAccumulatedTrimmed(): void {
  currentStats = null;
  lastRenderedState = null;
  pendingStats = null;
  if (pendingUpdateTimer !== null) {
    clearTimeout(pendingUpdateTimer);
    pendingUpdateTimer = null;
  }

  if (!isVisible) {
    return;
  }

  const bar = getOrCreateStatusBar();
  if (!bar) {
    return;
  }

  renderWaitingStatusBar(bar);
}

/**
 * Refresh status bar after SPA navigation or DOM resets
 */
export function refreshStatusBar(): void {
  if (!isVisible) {
    return;
  }

  const bar = getOrCreateStatusBar();
  if (!bar) {
    return;
  }

  bar.style.display = 'inline-flex';
  bar.classList.remove(STATUS_HIDDEN_CLASS);

  if (currentStats) {
    const { text, state } = getStatusText(currentStats);
    setBarText(bar, text, state);
    applyStateStyles(bar, state);
    lastUpdateTime = performance.now();
    return;
  }

  renderWaitingStatusBar(bar);
}

/**
 * Set status bar visibility based on settings
 */
export function setStatusBarVisibility(visible: boolean): void {
  if (visible) {
    showStatusBar();
  } else {
    hideStatusBar();
  }
}
