/**
 * Trimly - Status Bar
 * Compact floating pill indicator showing trimming statistics
 */

import { TIMING } from '../shared/constants';
import browser from '../shared/browser-polyfill';

const STATUS_BAR_ID = 'trimly-status-bar';
const STATUS_BAR_STYLE_ID = 'trimly-status-style';
const STATUS_LOGO_URL = browser.runtime.getURL('assets/icons/128x128.png');

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
    borderColor: 'rgba(255, 255, 255, 0.32)',
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
    .ls-status-logo-wrap {
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
      text: `Showing ${stats.visibleMessages} • ${stats.trimmedMessages} trimmed`,
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
      text: `Showing ${stats.totalMessages}`,
      state: 'all-visible',
    };
  }

  return {
    text: `Showing ${stats.visibleMessages}`,
    state: 'active',
  };
}

function setBarText(bar: HTMLElement, text: string, state: StatusBarState): void {
  bar.textContent = '';
  if (state === 'waiting') {
    const wrap = document.createElement('span');
    wrap.className = 'ls-status-logo-wrap';
    const logo = document.createElement('img');
    logo.className = 'ls-status-logo';
    logo.src = STATUS_LOGO_URL;
    logo.alt = '';
    logo.setAttribute('aria-hidden', 'true');
    wrap.appendChild(logo);
    bar.appendChild(wrap);
    return;
  }
  bar.textContent = text;
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

  bar.style.display = 'inline-flex';

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
    bar.style.display = 'none';
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

  bar.style.display = 'block';

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
