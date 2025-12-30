/**
 * LightSession for ChatGPT - Content Script Entry Point
 * Initializes trimmer state machine and wires up event handlers
 */

import '../shared/browser-polyfill';
import '../shared/idle-callback-polyfill';
import type { TrimmerState, LsSettings } from '../shared/types';
import { TIMING } from '../shared/constants';
import { loadSettings } from '../shared/storage';
import { setDebugMode, logInfo, logError } from '../shared/logger';
import { findConversationRoot, invalidateMessagesRootCache, invalidateScrollerCache } from './dom-helpers';
import { createInitialState, boot, shutdown, scheduleTrim, evaluateTrim, setOnTrimComplete, maybeTransitionToSteady, setStreamObserverCallback, isTrimSuppressed } from './trimmer';
import { isMutationSuppressed } from './compactor';
import { invalidateAllSelectorCaches } from './selectors';
import { invalidateComposerCache } from './observers';
import { setStatusBarVisibility, removeStatusBar, resetAccumulatedTrimmed, showLayoutNotRecognized } from './status-bar';

// Global state
let state: TrimmerState = createInitialState();
let pageObserver: MutationObserver | null = null;
let navigationCleanup: (() => void) | null = null;
let pendingRootSync = false;
let pendingRootSyncReason: string | null = null;
let pretrimDisabled = false;
let bootTransitionTimerId: number | null = null;

// Latched flush for suppressed mutations - ensures mutations aren't lost
let suppressedMutationPending = false;
let suppressedFlushTimer: number | null = null;
const SUPPRESSED_FLUSH_INTERVAL_MS = 120;

// rAF coalescing - ensures at most 1 mutation handling per frame
// Reduces "drebezg" from rapid DOM changes without delaying response
let rafPending: number | null = null;
let rafForceFlag = false; // Track if any coalesced mutation was forced

// ============================================================================
// Typing Guard (pause trimmer while user is typing in composer)
// ============================================================================

/**
 * Timestamp-based typing guard.
 * While performance.now() < typingUntil, all non-forced mutations are skipped.
 * Simpler and more reliable than flag-based approach.
 */
const TYPING_GRACE_MS = 300; // Grace period after last input
let typingUntil = 0;
let typingFlushTimer: number | null = null;

/**
 * Mark that user is typing - extends the typing guard.
 * Called on keyboard/input events in composer.
 */
function markTyping(): void {
  typingUntil = performance.now() + TYPING_GRACE_MS;

  // Schedule one forced flush after typing stops
  if (typingFlushTimer !== null) {
    clearTimeout(typingFlushTimer);
  }
  typingFlushTimer = window.setTimeout(() => {
    typingFlushTimer = null;
    // Flush any pending mutation with force to catch up
    if (suppressedMutationPending && state.settings.enabled) {
      suppressedMutationPending = false;
      handleMutation(true);
    }
  }, TYPING_GRACE_MS + 50);
}

/**
 * Clear typing guard state.
 * Called on navigation/rebind to reset state.
 */
function clearTypingHold(): void {
  if (typingFlushTimer !== null) {
    clearTimeout(typingFlushTimer);
    typingFlushTimer = null;
  }
  typingUntil = 0;
}

/**
 * Setup typing guard listeners.
 * Binds to composer input events to pause trimmer during typing.
 */
function setupTypingHold(): void {
  // Capture phase listeners for maximum reliability
  const options = { passive: true, capture: true };

  // keyboard events - most reliable for actual typing
  document.addEventListener('keydown', (e) => {
    if (isPromptNode(e.target)) markTyping();
  }, options);

  // input events - catches paste, autocomplete, etc.
  document.addEventListener('input', (e) => {
    if (isPromptNode(e.target)) markTyping();
  }, options);

  // composition events - for IME input (CJK, etc.)
  document.addEventListener('compositionstart', (e) => {
    if (isPromptNode(e.target)) markTyping();
  }, options);
  document.addEventListener('compositionupdate', (e) => {
    if (isPromptNode(e.target)) markTyping();
  }, options);
}

/**
 * High-priority selectors for ChatGPT's main composer.
 * These are specific and reliable.
 */
const PROMPT_SELECTORS_PRIMARY = [
  '#prompt-textarea',
  '[data-testid="prompt-textarea"]',
  'div[contenteditable="true"][data-testid="prompt-textarea"]',
];

/**
 * Low-priority selectors for generic text inputs.
 * Only match if inside a form or composer context.
 */
const PROMPT_SELECTORS_FALLBACK = [
  'textarea',
  '[contenteditable="true"]',
  '[role="textbox"]',
];

/**
 * Context selectors that indicate a composer container.
 * Note: plain 'form' is too broad (matches modals, search, login).
 * We use specific composer indicators instead.
 * Note: :has() is NOT used here because it can throw on older browsers.
 */
const COMPOSER_CONTEXT_SELECTORS = [
  '[data-testid*="composer" i]',
  '[class*="composer" i]',
];

/**
 * Check if element is inside a form that contains the main prompt textarea.
 * This is a programmatic alternative to 'form:has(#prompt-textarea)' which
 * would throw DOMException on browsers without :has() support.
 */
function isInComposerForm(el: HTMLElement): boolean {
  const form = el.closest('form');
  if (!form) return false;
  return !!form.querySelector('#prompt-textarea, [data-testid="prompt-textarea"]');
}

/**
 * Check if an element is part of the prompt/composer.
 * Uses tiered approach: specific selectors first, then generic with context check.
 */
function isPromptNode(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  // Priority 1: specific ChatGPT prompt selectors
  for (const sel of PROMPT_SELECTORS_PRIMARY) {
    if (target.matches(sel) || target.closest(sel)) return true;
  }

  // Priority 2: generic inputs, but only if inside composer context
  for (const sel of PROMPT_SELECTORS_FALLBACK) {
    if (target.matches(sel) || target.closest(sel)) {
      // Check data-testid/class-based composer context
      for (const ctx of COMPOSER_CONTEXT_SELECTORS) {
        if (target.closest(ctx)) return true;
      }
      // Check form-based composer context (programmatic, no :has())
      if (isInComposerForm(target)) return true;
    }
  }

  return false;
}

/**
 * Check if typing guard is active (user is actively typing).
 * Simple timestamp check - no flags needed.
 */
function isTypingHoldActive(): boolean {
  return performance.now() < typingUntil;
}

/**
 * Clear suppressed flush state.
 * Call this when disabling trimmer to prevent stale flush after disable.
 */
function clearSuppressedFlush(): void {
  if (suppressedFlushTimer !== null) {
    clearTimeout(suppressedFlushTimer);
    suppressedFlushTimer = null;
  }
  suppressedMutationPending = false;
}

/**
 * Clear rAF coalescing state.
 * Call this when disabling trimmer or on rebind.
 */
function clearRafCoalescing(): void {
  if (rafPending !== null) {
    cancelAnimationFrame(rafPending);
    rafPending = null;
  }
  rafForceFlag = false;
}

/**
 * Disable the pretrim CSS hide (set by early-hide.ts at document_start).
 * Called after first trim or when extension is disabled.
 */
function disablePretrim(): void {
  if (pretrimDisabled) {
    return;
  }
  pretrimDisabled = true;

  // Call the function set by early-hide.ts
  if (typeof window.__lsDisablePretrim === 'function') {
    window.__lsDisablePretrim();
    logInfo('Pretrim hide disabled');
  }
}

/**
 * Schedule guaranteed BOOT→STEADY transition.
 * This ensures transition happens even if no mutations occur.
 * Called after boot() to set a fallback timer.
 */
function scheduleBootTransition(): void {
  // Clear any existing timer
  if (bootTransitionTimerId !== null) {
    clearTimeout(bootTransitionTimerId);
  }

  // Schedule transition with small buffer after BOOT_DURATION_MS
  bootTransitionTimerId = window.setTimeout(() => {
    bootTransitionTimerId = null;
    if (state.trimMode === 'BOOT') {
      state = maybeTransitionToSteady(state, handleMutation);
    }
  }, TIMING.BOOT_DURATION_MS + 50);
}

/**
 * Cancel scheduled BOOT transition (called on shutdown).
 */
function cancelBootTransition(): void {
  if (bootTransitionTimerId !== null) {
    clearTimeout(bootTransitionTimerId);
    bootTransitionTimerId = null;
  }
}

// ============================================================================
// Ultra Lean & Hide Media CSS Mode Management
// ============================================================================

/**
 * Apply or remove Ultra Lean CSS class based on setting.
 * This enables/disables aggressive performance optimizations:
 * - Kill animations and transitions
 * - Remove shadows, blurs, filters
 * - Enhanced CSS containment
 * - Force instant scroll
 */
function setUltraLeanMode(enabled: boolean): void {
  if (enabled) {
    document.documentElement.classList.add('ls-ultra-lean');
  } else {
    document.documentElement.classList.remove('ls-ultra-lean');
  }
  logInfo(`Ultra Lean mode: ${enabled ? 'enabled' : 'disabled'}`);
}

// Type declaration for the global function from early-hide.ts
declare global {
  interface Window {
    __lsDisablePretrim?: () => void;
  }
}

// Store original history methods at module level to prevent memory leak
// from chained wrappers when navigation watcher is reinstalled
let originalPushState: typeof history.pushState | null = null;
let originalReplaceState: typeof history.replaceState | null = null;

/**
 * Schedule a root sync operation on the microtask queue.
 * Coalesces multiple triggers to a single ensure step.
 */
function requestRootSync(reason: string): void {
  pendingRootSyncReason = reason;

  if (pendingRootSync) {
    return;
  }

  pendingRootSync = true;

  void Promise.resolve().then(() => {
    pendingRootSync = false;
    const effectiveReason = pendingRootSyncReason || 'mutation';
    pendingRootSyncReason = null;
    ensureConversationBindings(effectiveReason);
  });
}

/**
 * Ensure the trimmer stays attached to the active conversation DOM.
 * Rebinds when ChatGPT replaces the thread container or navigates.
 */
function ensureConversationBindings(reason: string): void {
  if (!state.settings.enabled) {
    return;
  }

  const candidateRoot = findConversationRoot();
  if (!candidateRoot) {
    return;
  }

  const candidateIsFallback = candidateRoot === document.body;
  const currentRoot = state.conversationRoot;
  const rootMissing = !currentRoot || !document.contains(currentRoot);
  const observerMissing = !state.observer;
  const rootChanged = Boolean(candidateRoot && currentRoot && candidateRoot !== currentRoot);

  if (candidateIsFallback) {
    if ((rootMissing || observerMissing) && (state.current !== 'IDLE' || state.observer || currentRoot)) {
      teardownTrimmer();
      resetAccumulatedTrimmed(); // Reset stats so recovery starts fresh
      showLayoutNotRecognized(); // Show warning when layout is not recognized
    }
    return;
  }

  if (rootMissing || observerMissing || rootChanged || state.current === 'IDLE') {
    rebindTrimmer(reason);
  }
}

/**
 * Clean up current trimmer bindings without disabling the feature.
 */
function teardownTrimmer(): void {
  cancelBootTransition(); // Cancel pending BOOT→STEADY timer
  if (state.current !== 'IDLE' || state.observer || state.conversationRoot) {
    state = shutdown(state);
  }
}

/**
 * Reboot the trimmer against the latest conversation DOM.
 */
function rebindTrimmer(reason: string): void {
  logInfo(`Rebinding trimmer (${reason})`);

  // Reset trimmed counter on navigation to new chat
  if (reason.includes('state') || reason.includes('navigation') || reason === 'pushstate' || reason === 'popstate') {
    resetAccumulatedTrimmed();
  }

  // Clear pending callbacks to prevent them firing on new phase
  clearSuppressedFlush();
  clearRafCoalescing();
  clearTypingHold();

  // Invalidate caches on rebind - DOM structure may have changed
  invalidateAllSelectorCaches();
  invalidateComposerCache();
  invalidateScrollerCache();

  state = shutdown(state);

  if (!state.settings.enabled) {
    return;
  }

  state = boot(state, handleMutation);
  scheduleBootTransition(); // Guarantee BOOT→STEADY even without mutations

  if (state.current !== 'OBSERVING' || !state.conversationRoot) {
    return;
  }

  state = evaluateTrim(state, { force: true });
}

/**
 * Start global watchers that detect navigation and major DOM swaps.
 */
function startRootSyncWatchers(): void {
  if (document.body && !pageObserver) {
    let rafId: number | null = null;

    pageObserver = new MutationObserver(() => {
      if (rafId !== null) {
        return;
      }

      rafId = requestAnimationFrame(() => {
        rafId = null;
        requestRootSync('dom-mutation');
      });
    });

    pageObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  if (!navigationCleanup) {
    navigationCleanup = installNavigationWatcher((navReason) => {
      requestRootSync(navReason);
    });
  }

  requestRootSync('watchers-start');
}

/**
 * Stop global watchers when the extension is disabled.
 */
function stopRootSyncWatchers(): void {
  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
  }

  if (navigationCleanup) {
    navigationCleanup();
    navigationCleanup = null;
  }
}

/**
 * Listen for SPA navigation changes (pushState/replaceState/popstate/hashchange).
 * Uses module-level storage for original history methods to prevent memory leak
 * from chained wrappers when reinstalled.
 */
function installNavigationWatcher(onChange: (reason: string) => void): () => void {
  let lastUrl = window.location.href;

  const scheduleCheck = (reason: string): void => {
    void Promise.resolve().then(() => {
      const current = window.location.href;
      if (current === lastUrl) {
        return;
      }

      lastUrl = current;
      onChange(reason);
    });
  };

  const handlePopState = (): void => scheduleCheck('popstate');
  const handleHashChange = (): void => scheduleCheck('hashchange');

  window.addEventListener('popstate', handlePopState);
  window.addEventListener('hashchange', handleHashChange);

  // Only capture original methods on first installation to prevent
  // saving already-wrapped versions and creating a chain of wrappers
  if (!originalPushState) {
    originalPushState = history.pushState.bind(history);
  }
  if (!originalReplaceState) {
    originalReplaceState = history.replaceState.bind(history);
  }

  // Create typed references for use in wrapper functions
  const boundPushState = originalPushState;
  const boundReplaceState = originalReplaceState;

  history.pushState = function (
    ...args: Parameters<typeof history.pushState>
  ): ReturnType<typeof history.pushState> {
    const result = boundPushState(...args);
    scheduleCheck('pushstate');
    return result;
  };

  history.replaceState = function (
    ...args: Parameters<typeof history.replaceState>
  ): ReturnType<typeof history.replaceState> {
    const result = boundReplaceState(...args);
    scheduleCheck('replacestate');
    return result;
  };

  return () => {
    window.removeEventListener('popstate', handlePopState);
    window.removeEventListener('hashchange', handleHashChange);
    // Always restore to true originals stored at module level
    if (originalPushState) {
      history.pushState = originalPushState;
    }
    if (originalReplaceState) {
      history.replaceState = originalReplaceState;
    }
  };
}

/**
 * Initialize content script
 */
async function initialize(): Promise<void> {
  try {
    logInfo('LightSession content script initializing...');

    // Load settings
    const settings = await loadSettings();
    state.settings = settings;
    setDebugMode(settings.debug);

    // Set up callback to handle potentially missed mutations during trim
    // This ensures DOM is re-evaluated after observer reconnection
    setOnTrimComplete(() => {
      // Disable pretrim hide after first successful trim
      disablePretrim();

      // Only re-evaluate if trimmer is active and not already scheduled
      if (state.current === 'OBSERVING' && !state.trimScheduled) {
        // Only force if there was a suppressed mutation waiting
        // Otherwise, normal non-forced handling is sufficient
        const shouldForce = suppressedMutationPending;
        if (shouldForce) {
          suppressedMutationPending = false;
        }
        handleMutation(shouldForce);
      }
    });

    // Set up stream observer callback (used by evaluateTrim for SHALLOW mode)
    setStreamObserverCallback(handleMutation);

    // Set up typing hold listeners (pause trimmer while typing in composer)
    setupTypingHold();

    // Apply CSS modes based on settings (always apply regardless of enabled state)
    setUltraLeanMode(settings.ultraLean);

    // Boot trimmer if enabled
    if (settings.enabled) {
      startRootSyncWatchers();

      state = boot(state, handleMutation);
      scheduleBootTransition(); // Guarantee BOOT→STEADY even without mutations

      // Initialize status bar visibility
      setStatusBarVisibility(settings.showStatusBar);

      if (state.current === 'OBSERVING') {
        handleMutation();
      } else {
        requestRootSync('initialize');
      }
    } else {
      // Extension is disabled - show messages (disable pretrim)
      // Note: CSS modes (ultraLean, hideMedia) remain active - they work independently
      disablePretrim();
      stopRootSyncWatchers();
      removeStatusBar();
    }

    logInfo('LightSession initialized successfully');
  } catch (error) {
    logError('Failed to initialize content script:', error);
  }
}

/**
 * Schedule a flush of suppressed mutations after suppression ends.
 * This ensures mutations that occurred during compactor or trim work aren't lost.
 */
function scheduleSuppressedFlush(): void {
  if (suppressedFlushTimer !== null) {
    return;
  }

  suppressedFlushTimer = window.setTimeout(() => {
    suppressedFlushTimer = null;

    // If suppression is still active (compactor, trim, or typing), reschedule
    if (isMutationSuppressed() || isTrimSuppressed() || isTypingHoldActive()) {
      scheduleSuppressedFlush();
      return;
    }

    // Suppression ended - flush pending mutation if any
    // But only if trimmer is still enabled (avoid triggering after disable)
    if (suppressedMutationPending) {
      suppressedMutationPending = false;
      if (state.settings.enabled) {
        handleMutation(true); // forced to ensure re-evaluation
      }
    }
  }, SUPPRESSED_FLUSH_INTERVAL_MS);
}

/**
 * Internal mutation handler - does the actual work.
 * Called directly in BOOT mode or via rAF in STEADY mode.
 */
function handleMutationInternal(force: boolean): void {
  ensureConversationBindings(force ? 'forced-trim' : 'mutation');

  // Check if BOOT mode should transition to STEADY mode
  // This happens after BOOT_DURATION_MS has elapsed since boot
  state = maybeTransitionToSteady(state, handleMutation);

  // Capture settings snapshot at scheduling time to prevent race conditions
  // where settings might change between scheduling and evaluation
  const settingsSnapshot = { ...state.settings };

  state = scheduleTrim(
    state,
    () => {
      state = evaluateTrim(state, { force, settings: settingsSnapshot });
    },
    // onComplete callback ensures trimScheduled is reset even on error
    () => {
      state = { ...state, trimScheduled: false };
    }
  );

  // Note: Stream observer is managed by evaluateTrim which has access to lastNode
  // This avoids redundant DOM scans - evaluateTrim already builds the node list
}

/**
 * Handle mutation events with rAF coalescing.
 * - BOOT mode: immediate handling for pre-paint trimming
 * - STEADY mode: coalesced via rAF (max 1 per frame) to reduce drebezg
 */
function handleMutation(force = false): void {
  // Skip if compactor or trimmer is actively modifying DOM to prevent re-triggering loops
  // Also skip if user is actively typing in composer (prevents input lag)
  // But latch the mutation so we don't lose it - will flush after suppression ends
  // isMutationSuppressed: compactor is dehighlighting code blocks
  // isTrimSuppressed: trimmer is removing nodes (prevents echo cycles)
  // isTypingHoldActive: user is typing in composer
  if (!force && (isMutationSuppressed() || isTrimSuppressed() || isTypingHoldActive())) {
    suppressedMutationPending = true;
    scheduleSuppressedFlush();
    return;
  }

  // BOOT mode: handle immediately (no coalescing - need pre-paint speed)
  if (state.trimMode === 'BOOT') {
    handleMutationInternal(force);
    return;
  }

  // STEADY mode: coalesce via rAF (max 1 handling per frame)
  // Track if any coalesced mutation was forced
  if (force) {
    rafForceFlag = true;
  }

  // Already scheduled? Just update force flag and return
  if (rafPending !== null) {
    return;
  }

  rafPending = requestAnimationFrame(() => {
    rafPending = null;
    const wasForced = rafForceFlag;
    rafForceFlag = false;
    handleMutationInternal(wasForced);
  });
}

/**
 * Handle storage changes (settings updates from popup)
 */
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.ls_settings) {
    return;
  }

  const newSettings = changes.ls_settings.newValue as LsSettings | undefined;
  if (!newSettings) {
    return;
  }

  logInfo('Settings changed, updating state');

  // Update debug mode
  setDebugMode(newSettings.debug);

  // Handle enable/disable toggle
  const previousSettings = state.settings;
  const wasEnabled = previousSettings.enabled;
  const nowEnabled = newSettings.enabled;

  state.settings = newSettings;

  // Handle CSS mode changes (always apply regardless of enabled state)
  if (previousSettings.ultraLean !== newSettings.ultraLean) {
    setUltraLeanMode(newSettings.ultraLean);
    invalidateMessagesRootCache(); // Clear root cache when ultraLean changes
  }

  if (!wasEnabled && nowEnabled) {
    // Extension was just enabled
    logInfo('Extension enabled, booting trimmer');
    startRootSyncWatchers();
    // CSS modes already handled above (lines 437-443) - no need to re-apply
    state = boot(state, handleMutation);
    scheduleBootTransition(); // Guarantee BOOT→STEADY even without mutations
    setStatusBarVisibility(newSettings.showStatusBar);

    if (state.current === 'OBSERVING') {
      handleMutation();
    } else {
      requestRootSync('enable');
    }
  } else if (wasEnabled && !nowEnabled) {
    // Extension was just disabled - show messages (disable pretrim)
    // Note: CSS modes remain active - they work independently of trimmer
    logInfo('Extension disabled, shutting down trimmer');
    disablePretrim();
    stopRootSyncWatchers();
    clearSuppressedFlush(); // Cancel pending flush to avoid triggering after disable
    clearRafCoalescing(); // Cancel pending rAF to avoid triggering after disable
    clearTypingHold(); // Cancel typing hold timer
    teardownTrimmer();
    removeStatusBar();
  } else if (nowEnabled) {
    // Extension still enabled, settings changed
    // Re-evaluate trim with new settings (e.g., keep count changed)
    const forceTrim = previousSettings.keep !== newSettings.keep;

    // Handle showStatusBar setting change
    if (previousSettings.showStatusBar !== newSettings.showStatusBar) {
      setStatusBarVisibility(newSettings.showStatusBar);
    }

    // If ultraLean changed, need to rebind with new observer root/config
    if (previousSettings.ultraLean !== newSettings.ultraLean) {
      rebindTrimmer('ultraLean-change');
    } else {
      requestRootSync('settings-change');
      handleMutation(forceTrim);
    }
  } else {
    // Remain disabled - ensure pretrim is disabled
    // Note: CSS modes still handled above (lines 437-443) if they changed
    disablePretrim();
    stopRootSyncWatchers();
    teardownTrimmer();
    removeStatusBar();
  }
});

/**
 * Wait for DOM to be ready, then initialize
 */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initialize().catch((error) => {
      logError('Initialization failed:', error);
    });
  });
} else {
  // DOMContentLoaded already fired
  initialize().catch((error) => {
    logError('Initialization failed:', error);
  });
}

/**
 * Global error handler to prevent extension errors from breaking the page
 */
window.addEventListener('error', (event) => {
  // Only handle errors from our extension
  if (event.message?.includes('LS:') || event.filename?.includes('light-session')) {
    logError('Unhandled error:', event.error || event.message);
    event.preventDefault(); // Prevent page break
  }
});

window.addEventListener('unhandledrejection', (event) => {
  logError('Unhandled promise rejection:', event.reason);
  event.preventDefault(); // Prevent page break
});
