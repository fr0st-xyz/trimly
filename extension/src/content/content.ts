/**
 * Trimly - Content Script
 *
 * Simplified content script that works with the Fetch Proxy (page-script.ts).
 * Responsibilities:
 * - Load and dispatch settings to the page script
 * - Listen for trim status from the page script
 * - Manage the status bar UI
 * - Handle settings changes from popup/storage
 */

import browser from '../shared/browser-polyfill';
import type { LsSettings, TrimStatus } from '../shared/types';
import { loadSettings, validateSettings, syncToLocalStorage } from '../shared/storage';
import { TIMING } from '../shared/constants';
import { setDebugMode, logDebug, logInfo, logWarn, logError } from '../shared/logger';
import {
  updateStatusBar,
  resetAccumulatedTrimmed,
  refreshStatusBar,
  setStatusBarVisibility,
} from './status-bar';
import { isEmptyChatView } from './chat-view';
import { installUserCollapse, type UserCollapseController } from './user-collapse';
import { isTrimlyRejection } from './rejection-filter';
import { installDomTrimmer, type DomTrimmerController, type DomTrimStatus } from './dom-trimmer';


// ============================================================================
// Types for Page Script Communication
// ============================================================================

interface PageScriptConfig {
  enabled: boolean;
  limit: number;
  debug: boolean;
}

interface ChatCountPayload {
  total: number;
  visible: number;
  trimmed: number;
}

/**
 * Type guard for TrimStatus.
 * Validates that event.detail from page script has expected shape.
 */
function isValidTrimStatus(obj: unknown): obj is TrimStatus {
  if (typeof obj !== 'object' || obj === null) return false;
  const s = obj as Record<string, unknown>;
  return (
    typeof s.totalBefore === 'number' &&
    typeof s.keptAfter === 'number' &&
    typeof s.removed === 'number' &&
    typeof s.limit === 'number'
  );
}

// ============================================================================
// Global State
// ============================================================================

let currentSettings: LsSettings | null = null;
let proxyReady = false;
let emptyChatState = false;
let emptyChatCheckTimer: number | null = null;
let emptyChatObserver: MutationObserver | null = null;
let liveCountObserver: MutationObserver | null = null;
let liveCountCheckTimer: number | null = null;
let lastObservedUserCount = -1;
let userCollapse: UserCollapseController | null = null;
let domTrimmer: DomTrimmerController | null = null;
let authoritativeTotalRounds: number | null = null;
let latestTrimStatus: TrimStatus | null = null;
const conversationTotalsCache = new Map<string, number>();
let lastUserSendSignalAt = 0;
const seenSendMarkerKeys = new Map<string, number>();
let lastBackfillReloadAt = 0;
let lastKeepOneReloadAt = 0;
const SESSION_TOTAL_KEY_PREFIX = 'trimly:v4:conversation-total:';
const SEND_RECENCY_WINDOW_MS = 5000;

// ============================================================================
// Page Script Communication
// ============================================================================

/**
 * Dispatch configuration to the page script via CustomEvent.
 * The page script listens for 'trimly-config' events.
 *
 * Cross-browser compatibility:
 * - Firefox: Content scripts run in an isolated sandbox (Xray vision).
 *   We use cloneInto() to clone objects into page context.
 * - Chrome: Content scripts run in "isolated worlds". Objects passed via
 *   CustomEvent.detail may not be accessible to page scripts reliably.
 *
 * Solution: Always serialize config to JSON string. This works in both browsers
 * and avoids issues with object cloning across isolation boundaries.
 *
 * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Sharing_objects_with_page_scripts
 */
function dispatchConfig(settings: LsSettings): void {
  const config: PageScriptConfig = {
    enabled: settings.enabled,
    limit: settings.keep,
    debug: settings.debug,
  };

  // Serialize to JSON string for cross-browser compatibility
  // Chrome's isolated worlds don't reliably pass objects via CustomEvent.detail
  // JSON string is safely passed as a primitive
  const jsonString = JSON.stringify(config);

  window.dispatchEvent(new CustomEvent('trimly-config', { detail: jsonString }));

  logDebug('Dispatched config to page script:', config);
}

/**
 * Handle trim status from the page script.
 * Updates the status bar with trim statistics.
 */
function handleTrimStatus(event: CustomEvent<unknown>): void {
  const status = event.detail;

  if (!isValidTrimStatus(status)) {
    logWarn('Invalid trim status received:', status);
    return;
  }

  // Ignore stale status events when not in a conversation route.
  if (!isConversationRoute()) {
    latestTrimStatus = null;
    updateStatusBar({
      totalMessages: 0,
      visibleMessages: 0,
      trimmedMessages: 0,
      keepLastN: Math.max(1, currentSettings?.keep ?? 10),
    });
    return;
  }

  logDebug('Received trim status:', status);
  const domCounts = getDomChatCounts();
  const cachedTotal = getCachedConversationTotal() ?? 0;
  const recentSend = Date.now() - lastUserSendSignalAt < SEND_RECENCY_WINDOW_MS;
  let stableTotal = status.totalBefore;
  // Block only the common phantom refresh +1 (no send + no DOM growth).
  if (!recentSend && cachedTotal > 0 && stableTotal === cachedTotal + 1 && domCounts.total <= cachedTotal) {
    stableTotal = cachedTotal;
  }
  // Let real fetch status correct prior fallback/cache drift; only floor to DOM proof.
  stableTotal = Math.max(stableTotal, domCounts.total);

  latestTrimStatus = {
    ...status,
    totalBefore: stableTotal,
    keptAfter: Math.min(stableTotal, status.keptAfter),
    removed: Math.max(0, stableTotal - Math.min(stableTotal, status.keptAfter)),
  };
  authoritativeTotalRounds = stableTotal;
  cacheConversationTotal(stableTotal);
  const keep = Math.max(1, currentSettings?.keep ?? status.limit);
  const visible = currentSettings?.enabled === false ? stableTotal : Math.min(stableTotal, keep);

  // Convert page script status format to status bar format
  updateStatusBar({
    totalMessages: stableTotal,
    visibleMessages: visible,
    trimmedMessages: Math.max(0, stableTotal - visible),
    keepLastN: keep,
  });

}

function handleDomTrimStatus(status: DomTrimStatus): void {
  if (!isConversationRoute()) {
    updateStatusBar({
      totalMessages: 0,
      visibleMessages: 0,
      trimmedMessages: 0,
      keepLastN: Math.max(1, currentSettings?.keep ?? 10),
    });
    return;
  }

  // Do not override fetch-trim stats when we have authoritative data.
  if (latestTrimStatus !== null) {
    return;
  }

  const domCounts = getDomChatCounts();
  const cachedTotal = getCachedConversationTotal() ?? 0;
  const totalRounds = authoritativeTotalRounds === null
    ? Math.max(domCounts.total, cachedTotal)
    : Math.max(authoritativeTotalRounds, domCounts.total, cachedTotal);
  authoritativeTotalRounds = totalRounds;
  cacheConversationTotal(totalRounds);
  const visibleRounds = currentSettings?.enabled ? Math.min(totalRounds, Math.max(1, status.keep)) : totalRounds;
  const trimmedRounds = Math.max(0, totalRounds - visibleRounds);

  updateStatusBar({
    totalMessages: totalRounds,
    visibleMessages: visibleRounds,
    trimmedMessages: trimmedRounds,
    keepLastN: status.keep,
  });
}

function getDomChatCounts(): ChatCountPayload {
  if (!isConversationRoute()) {
    return { total: 0, visible: 0, trimmed: 0 };
  }

  const root = document.querySelector('main') ?? document;
  const turns = Array.from(
    root.querySelectorAll<HTMLElement>('[data-message-author-role="user"][data-message-id]')
  );
  const allIds = new Set<string>();
  const visibleIds = new Set<string>();

  for (const turn of turns) {
    const id = turn.getAttribute('data-message-id');
    if (!id) {
      continue;
    }
    allIds.add(id);
    if (!turn.closest('[data-ls-dom-trimmed], [data-ls-dom-shell-collapsed]')) {
      visibleIds.add(id);
    }
  }

  const total = allIds.size;
  const visible = visibleIds.size;

  return {
    total,
    visible,
    trimmed: Math.max(0, total - visible),
  };
}

function getChatCounts(): ChatCountPayload {
  if (latestTrimStatus !== null && isConversationRoute()) {
    const total = latestTrimStatus.totalBefore;
    const keep = Math.max(1, currentSettings?.keep ?? latestTrimStatus.limit);
    const visible = currentSettings?.enabled === false ? total : Math.min(total, keep);
    return {
      total,
      visible,
      trimmed: Math.max(0, total - visible),
    };
  }

  // Prefer authoritative totals from fetch-trim status (full conversation),
  // then merge with live DOM counts.
  const dom = getDomChatCounts();
  const cachedTotal = getCachedConversationTotal() ?? 0;
  let total = authoritativeTotalRounds === null
    ? Math.max(dom.total, cachedTotal)
    : Math.max(authoritativeTotalRounds, dom.total, cachedTotal);

  // Guard against stale phantom +1 totals that can persist after refreshes.
  // When we only have DOM/cache fallback (no fresh trim status), trust DOM if
  // fallback is exactly one higher.
  const recentSend = Date.now() - lastUserSendSignalAt < SEND_RECENCY_WINDOW_MS;
  if (!recentSend && dom.total > 0 && total === dom.total + 1) {
    total = dom.total;
    authoritativeTotalRounds = total;
    cacheConversationTotal(total);
  }

  const keep = Math.max(1, currentSettings?.keep ?? dom.visible);
  const visible = currentSettings?.enabled === false ? total : Math.min(total, keep);
  return {
    total,
    visible,
    trimmed: Math.max(0, total - visible),
  };
}

function isConversationRoute(): boolean {
  // ChatGPT conversation pages are typically /c/<id> (and shared routes).
  const path = location.pathname || '';
  return /^\/(c|share)\/[^/]+\/?$/.test(path);
}

function maybeReloadForBackfill(prevSettings: LsSettings | null, nextSettings: LsSettings): void {
  if (!prevSettings) {
    return;
  }
  if (!nextSettings.enabled) {
    return;
  }
  if (nextSettings.keep <= prevSettings.keep) {
    return;
  }

  const domRounds = getDomChatCounts().total;
  const totalRounds = authoritativeTotalRounds === null
    ? domRounds
    : Math.max(authoritativeTotalRounds, domRounds);

  // If user increased keep beyond currently loaded rounds, ChatGPT must re-fetch
  // older rounds. Trigger a single guarded reload only when strictly needed.
  if (domRounds >= nextSettings.keep || totalRounds <= domRounds) {
    return;
  }
  if (!isConversationRoute()) {
    return;
  }

  const now = Date.now();
  if (now - lastBackfillReloadAt < 8000) {
    return;
  }
  lastBackfillReloadAt = now;

  logInfo(
    'Reloading conversation to backfill older rounds',
    { domRounds, totalRounds, keep: nextSettings.keep }
  );
  window.setTimeout(() => {
    window.location.reload();
  }, 120);
}

function getConversationKey(pathname: string = location.pathname): string | null {
  const match = pathname.match(/^\/(c|share)\/([^/]+)\/?$/);
  if (!match) {
    return null;
  }
  return `${match[1]}:${match[2]}`;
}

function getCachedConversationTotal(): number | null {
  const key = getConversationKey();
  if (!key) {
    return null;
  }
  const inMemory = conversationTotalsCache.get(key);
  if (typeof inMemory === 'number') {
    return inMemory;
  }

  try {
    const raw = sessionStorage.getItem(`${SESSION_TOTAL_KEY_PREFIX}${key}`);
    if (!raw) {
      return null;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    conversationTotalsCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function cacheConversationTotal(total: number): void {
  if (total <= 0) {
    return;
  }
  const key = getConversationKey();
  if (!key) {
    return;
  }
  conversationTotalsCache.set(key, total);
  try {
    sessionStorage.setItem(`${SESSION_TOTAL_KEY_PREFIX}${key}`, String(total));
  } catch {
    // Ignore storage access/quota issues.
  }
  // Keep cache bounded.
  if (conversationTotalsCache.size > 120) {
    const oldestKey = conversationTotalsCache.keys().next().value as string | undefined;
    if (oldestKey) {
      conversationTotalsCache.delete(oldestKey);
    }
  }
}

function maybeReloadForKeepOneStability(
  prevSettings: LsSettings | null,
  nextSettings: LsSettings
): void {
  if (!prevSettings) {
    return;
  }
  if (!nextSettings.enabled) {
    return;
  }
  if (nextSettings.keep !== 1 || prevSettings.keep === 1) {
    return;
  }
  if (!isConversationRoute()) {
    return;
  }

  // keep=1 live DOM trimming can leave stale virtualized layout shells in some
  // ChatGPT revisions (large empty space below composer). A guarded one-time reload
  // ensures the thread is rebuilt in a stable state.
  const now = Date.now();
  if (now - lastKeepOneReloadAt < 8000) {
    return;
  }
  lastKeepOneReloadAt = now;

  logInfo('Reloading conversation for keep=1 stability');
  window.setTimeout(() => {
    window.location.reload();
  }, 120);
}

/**
 * Handle proxy ready message from page script.
 * Called when the page script has successfully patched window.fetch.
 */
function handleProxyReady(): void {
  proxyReady = true;
  logInfo('Fetch proxy is ready');

  // Dispatch current config now that proxy is ready
  if (currentSettings) {
    dispatchConfig(currentSettings);
  }
}

/**
 * Check if the proxy was successfully installed.
 * Shows a warning in the status bar if not.
 */
function checkProxyStatus(): void {
  if (!proxyReady) {
    logWarn('Fetch proxy did not signal ready within timeout');
    // Don't show warning to user - proxy may still work, just didn't send ready message
  }
}

// ============================================================================
// Settings Management
// ============================================================================

/**
 * Apply settings changes.
 * Dispatches config to page script and updates status bar visibility.
 */
function applySettings(settings: LsSettings): void {
  const prevSettings = currentSettings;
  currentSettings = settings;
  if (!settings.enabled) {
    authoritativeTotalRounds = null;
  }

  // Update debug mode
  setDebugMode(settings.debug);

  // Dispatch config to page script
  dispatchConfig(settings);

  // Handle status bar visibility
  setStatusBarVisibility(settings.showStatusBar && settings.enabled);

  // Reset accumulated count on enable toggle
  if (prevSettings && prevSettings.enabled !== settings.enabled) {
    resetAccumulatedTrimmed();
  }

  // Apply Ultra Lean CSS mode (works independently of trimmer)
  setUltraLeanMode(settings.ultraLean);

  // Collapse long user messages (presentation-only; local DOM feature)
  const shouldCollapseLongUserMessages =
    settings.enabled &&
    settings.collapseLongUserMessages &&
    settings.keep > 1;
  if (shouldCollapseLongUserMessages) {
    if (!userCollapse) {
      userCollapse = installUserCollapse();
    }
    userCollapse.enable();
  } else if (userCollapse) {
    userCollapse.teardown();
    userCollapse = null;
  }

  // Apply immediate DOM trimming so settings take effect without page reload.
  if (!domTrimmer) {
    domTrimmer = installDomTrimmer(handleDomTrimStatus);
  }
  domTrimmer.setConfig({
    enabled: settings.enabled,
    keep: settings.keep,
  });
  maybeReloadForBackfill(prevSettings, settings);
  maybeReloadForKeepOneStability(prevSettings, settings);

  logDebug('Settings applied:', settings);
}

/**
 * Apply or remove Ultra Lean CSS class based on setting.
 * This enables/disables aggressive performance optimizations.
 */
function setUltraLeanMode(enabled: boolean): void {
  if (enabled) {
    document.documentElement.classList.add('ls-ultra-lean');
  } else {
    document.documentElement.classList.remove('ls-ultra-lean');
  }
}

/**
 * Handle storage changes (settings updated from popup or another tab).
 */
function handleStorageChange(
  changes: Record<string, browser.storage.StorageChange>,
  areaName: string
): void {
  if (areaName !== 'local') {
    return;
  }

  if (!changes.ls_settings?.newValue) {
    return;
  }

  // Validate settings to ensure proper types and ranges
  const newSettings = validateSettings(changes.ls_settings.newValue as Partial<LsSettings>);
  logInfo('Settings changed via storage:', newSettings);

  // Sync to localStorage for page-script access (Chrome MV3 workaround)
  syncToLocalStorage(newSettings);

  applySettings(newSettings);
}

// ============================================================================
// Navigation Detection
// ============================================================================

/**
 * Detect SPA navigation within ChatGPT.
 * Resets accumulated trim count on chat changes.
 */
function setupNavigationDetection(): void {
  // Use full href as the navigation key. ChatGPT can navigate without changing pathname.
  let lastUrl = location.href;
  let navScheduled = false;

  const scheduleNavSideEffects = (source: 'popstate' | 'pushState' | 'replaceState'): void => {
    // Coalesce rapid history events into a single tick.
    if (navScheduled) return;
    navScheduled = true;
    queueMicrotask(() => {
      navScheduled = false;

      // Keep the key updated even if we decide not to run side effects.
      lastUrl = location.href;

      logDebug(`${source} navigation:`, lastUrl);
      authoritativeTotalRounds = null;
      latestTrimStatus = null;
      resetAccumulatedTrimmed();
      const keep = Math.max(1, currentSettings?.keep ?? 10);
      const cachedTotal = getCachedConversationTotal();
      if (cachedTotal && cachedTotal > 0 && isConversationRoute()) {
        authoritativeTotalRounds = cachedTotal;
        updateStatusBar({
          totalMessages: cachedTotal,
          visibleMessages: currentSettings?.enabled === false ? cachedTotal : Math.min(cachedTotal, keep),
          trimmedMessages: currentSettings?.enabled === false ? 0 : Math.max(0, cachedTotal - keep),
          keepLastN: keep,
        });
      } else {
        updateStatusBar({
          totalMessages: 0,
          visibleMessages: 0,
          trimmedMessages: 0,
          keepLastN: keep,
        });
      }
      refreshStatusBar();

      // Re-bind DOM observers for per-chat containers (SPA navigation can replace the message list DOM).
      // Make the settings intent explicit; userCollapse being non-null is an implementation detail.
      if (currentSettings?.enabled && currentSettings.collapseLongUserMessages) {
        userCollapse?.enable();
      }
      domTrimmer?.runNow();
      // ChatGPT sometimes mounts turns a bit later on rapid SPA switches.
      window.setTimeout(syncStatusFromCurrentCounts, 60);
      window.setTimeout(syncStatusFromCurrentCounts, 220);
      window.setTimeout(scheduleLiveCountCheck, 320);
    });
  };

  // Listen for popstate events
  window.addEventListener('popstate', () => {
    if (location.href !== lastUrl) {
      scheduleNavSideEffects('popstate');
    }
  });

  // Patch history methods for SPA navigation detection
  // Guard against double patching (e.g. extension reload / unexpected reinjection).
  const PATCH_FLAG = '__trimly_patched_history__';
  const patchScope = window as unknown as Record<string, unknown>;
  if (patchScope[PATCH_FLAG] === true) return;
  patchScope[PATCH_FLAG] = true;

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = function (...args: Parameters<typeof history.pushState>) {
    const result = originalPushState(...args);
    if (location.href !== lastUrl) {
      scheduleNavSideEffects('pushState');
    }
    return result;
  };

  history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
    const result = originalReplaceState(...args);
    if (location.href !== lastUrl) {
      scheduleNavSideEffects('replaceState');
    }
    return result;
  };
}

// ============================================================================
// Empty Chat Detection
// ============================================================================

function checkEmptyChatView(): void {
  const isEmpty = isEmptyChatView(document);
  if (isEmpty && !emptyChatState) {
    authoritativeTotalRounds = null;
    latestTrimStatus = null;
    resetAccumulatedTrimmed();
    refreshStatusBar();
  }
  emptyChatState = isEmpty;
}

function scheduleEmptyChatCheck(): void {
  if (emptyChatCheckTimer !== null) {
    return;
  }

  emptyChatCheckTimer = window.setTimeout(() => {
    emptyChatCheckTimer = null;
    checkEmptyChatView();
  }, 200);
}

function setupEmptyChatObserver(): void {
  if (emptyChatObserver) {
    return;
  }

  emptyChatObserver = new MutationObserver(() => {
    scheduleEmptyChatCheck();
  });

  emptyChatObserver.observe(document.documentElement, { childList: true, subtree: true });
  scheduleEmptyChatCheck();
}

function syncStatusFromCurrentCounts(): void {
  if (!currentSettings?.enabled || !currentSettings.showStatusBar) {
    return;
  }
  const counts = getChatCounts();
  updateStatusBar({
    totalMessages: counts.total,
    visibleMessages: counts.visible,
    trimmedMessages: counts.trimmed,
    keepLastN: Math.max(1, currentSettings.keep),
  });
}

function extractSendMarkerKey(event: Event): string | null {
  const custom = event as CustomEvent<unknown>;
  const detail = custom.detail;
  if (typeof detail === 'string') {
    try {
      const parsed = JSON.parse(detail) as { dedupeKey?: unknown };
      return typeof parsed.dedupeKey === 'string' ? parsed.dedupeKey : null;
    } catch {
      return null;
    }
  }
  if (typeof detail === 'object' && detail !== null) {
    const maybe = (detail as { dedupeKey?: unknown }).dedupeKey;
    return typeof maybe === 'string' ? maybe : null;
  }
  return null;
}

function handleUserSendSignal(event: Event): void {
  const key = extractSendMarkerKey(event);
  if (!key) {
    return;
  }

  const now = Date.now();
  const prev = seenSendMarkerKeys.get(key);
  if (prev && now - prev < 15000) {
    return;
  }
  seenSendMarkerKeys.set(key, now);
  if (seenSendMarkerKeys.size > 1200) {
    for (const [k, ts] of seenSendMarkerKeys) {
      if (now - ts > 15000) {
        seenSendMarkerKeys.delete(k);
      }
    }
  }

  // In Firefox refresh paths, fetch trim status can be delayed/missed.
  // Use send marker as authoritative "+1 turn" fallback per conversation.
  if (isConversationRoute()) {
    const dom = getDomChatCounts().total;
    const cached = getCachedConversationTotal() ?? 0;
    const baseTotal = authoritativeTotalRounds === null
      ? Math.max(dom, cached)
      : Math.max(authoritativeTotalRounds, dom, cached);
    const nextTotal = Math.max(1, baseTotal + 1);
    authoritativeTotalRounds = nextTotal;
    cacheConversationTotal(nextTotal);
  }

  lastUserSendSignalAt = Date.now();
  latestTrimStatus = null;
  syncStatusFromCurrentCounts();
  // Force recount after send marker so stale baseline cannot suppress updates.
  lastObservedUserCount = -1;
  scheduleLiveCountCheck();
  // Some ChatGPT UI updates land later than the first mutation batch.
  window.setTimeout(() => {
    lastObservedUserCount = -1;
    scheduleLiveCountCheck();
  }, 420);
}

function scheduleLiveCountCheck(): void {
  if (liveCountCheckTimer !== null) {
    return;
  }
  liveCountCheckTimer = window.setTimeout(() => {
    liveCountCheckTimer = null;
    if (!currentSettings?.enabled || !currentSettings.showStatusBar || !isConversationRoute()) {
      return;
    }
    const current = getDomChatCounts().total;
    if (current === lastObservedUserCount) {
      return;
    }
    lastObservedUserCount = current;
    syncStatusFromCurrentCounts();
  }, 120);
}

function setupLiveCountObserver(): void {
  if (liveCountObserver) {
    return;
  }
  liveCountObserver = new MutationObserver(() => {
    scheduleLiveCountCheck();
  });
  liveCountObserver.observe(document.documentElement, { childList: true, subtree: true });
  lastObservedUserCount = getDomChatCounts().total;
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Set up event listeners for page script communication.
 */
function setupEventListeners(): void {
  // Listen for trim status from page script
  window.addEventListener('trimly-status', ((event: CustomEvent<unknown>) => {
    handleTrimStatus(event);
  }) as EventListener);
  window.addEventListener('trimly-user-turn-sent', handleUserSendSignal as EventListener, true);

  // Listen for proxy ready signal
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    // Validate origin to prevent spoofing from other scripts
    if (event.origin !== location.origin) return;

    const data = event.data as { type?: string } | null;
    if (data?.type === 'trimly-proxy-ready') {
      handleProxyReady();
    }
  });

  // Listen for config request from page script (handles race condition)
  window.addEventListener('trimly-request-config', () => {
    if (currentSettings) {
      dispatchConfig(currentSettings);
    }
  });

  // Listen for storage changes
  browser.storage.onChanged.addListener(handleStorageChange);

  // Popup asks content script for live chat counts.
  browser.runtime.onMessage.addListener((message: unknown) => {
    const m = message as { type?: string } | null;
    if (m?.type !== 'LS_GET_CHAT_COUNTS') {
      return undefined;
    }
    return Promise.resolve({
      ok: true,
      counts: getChatCounts(),
    });
  });
}

/**
 * Main initialization function.
 */
async function initialize(): Promise<void> {
  try {
    logInfo('Trimly content script initializing...');

    // Set up event listeners first (before settings load)
    setupEventListeners();

    // Load initial settings
    const settings = await loadSettings();
    logInfo('Loaded settings:', settings);

    // Sync to localStorage for page-script access (Chrome MV3 workaround)
    syncToLocalStorage(settings);

    // Apply settings
    applySettings(settings);

    // Set up navigation detection
    setupNavigationDetection();

    // Detect empty chat state to reset stale status
    setupEmptyChatObserver();
    setupLiveCountObserver();
    syncStatusFromCurrentCounts();

    // Check proxy status after a short delay
    setTimeout(checkProxyStatus, TIMING.PROXY_READY_TIMEOUT_MS);

    logInfo('Trimly content script initialized');
  } catch (error) {
    logError('Failed to initialize:', error);
  }
}

// ============================================================================
// Entry Point
// ============================================================================

// Run initialization when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initialize().catch((error) => {
      logError('Initialization failed:', error);
    });
  });
} else {
  initialize().catch((error) => {
    logError('Initialization failed:', error);
  });
}

// ============================================================================
// Error Handlers
// ============================================================================

/**
 * Global error handler to prevent extension errors from breaking the page
 */
window.addEventListener('error', (event) => {
  if (event.message?.includes('LS:') || event.filename?.includes('trimly')) {
    logError('Unhandled error:', event.error || event.message);
    event.preventDefault();
  }
});

window.addEventListener('unhandledrejection', (event) => {
  let extensionUrlPrefix: string | undefined;
  try {
    extensionUrlPrefix = browser?.runtime?.getURL?.('');
  } catch {
    extensionUrlPrefix = undefined;
  }

  // Do not suppress site (ChatGPT) errors. Only suppress if it clearly originates from Trimly.
  const strictIsOurs = isTrimlyRejection(event.reason, extensionUrlPrefix);
  const looseIsOurs = isTrimlyRejection(event.reason);

  if (strictIsOurs || looseIsOurs) {
    logError('Unhandled promise rejection:', event.reason);

    // Only suppress default reporting if we are confident this originates from our extension.
    if (strictIsOurs) {
      event.preventDefault();
    }
  }
});
