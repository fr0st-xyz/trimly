/**
 * LightSession for ChatGPT - Observers
 * MutationObserver and scroll tracking with debouncing/throttling
 */

import { TIMING, DOM } from '../shared/constants';
import { logDebug } from '../shared/logger';
import type { TrimMode } from '../shared/types';

// ============================================================================
// Mutation Relevance Filtering
// ============================================================================

/**
 * Selectors for ChatGPT's composer/prompt area.
 * Mutations inside these elements should be ignored to prevent input lag.
 */
const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  'textarea[data-testid="prompt-textarea"]',
  'div[contenteditable="true"][data-testid="prompt-textarea"]',
  'form textarea',
  'form [contenteditable="true"]',
  '[data-testid="composer"]',
  '[class*="composer" i]',
];

/**
 * Fast selectors for identifying message-related nodes.
 * Derived from Tier A selectors - the most reliable indicators.
 */
const MESSAGE_INDICATOR_SELECTORS = [
  '[data-message-id]',
  '[data-turn]',
  '[data-testid="conversation-turn"]',
  '[data-testid^="conversation-turn-"]',
  '[data-testid="assistant-turn"]',
  '[data-testid="user-turn"]',
].join(',');

// Cache composer element (invalidated on navigation)
let cachedComposer: HTMLElement | null = null;
let composerCacheTime = 0;
const COMPOSER_CACHE_TTL_MS = 2000;

/**
 * Find the composer element (cached).
 */
function findComposer(): HTMLElement | null {
  const now = performance.now();
  if (cachedComposer && now - composerCacheTime < COMPOSER_CACHE_TTL_MS) {
    // Verify still in DOM
    if (cachedComposer.isConnected) {
      return cachedComposer;
    }
    cachedComposer = null;
  }

  for (const sel of COMPOSER_SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) {
      cachedComposer = el;
      composerCacheTime = now;
      return el;
    }
  }
  return null;
}

/**
 * Invalidate composer cache (call on navigation).
 */
export function invalidateComposerCache(): void {
  cachedComposer = null;
  composerCacheTime = 0;
}

/**
 * Check if a node looks like a message element (fast check).
 */
function isMessageish(node: Node): boolean {
  if (!(node instanceof HTMLElement)) return false;
  // Direct match
  if (node.matches(MESSAGE_INDICATOR_SELECTORS)) return true;
  // Contains a message (for container additions)
  return !!node.querySelector?.(MESSAGE_INDICATOR_SELECTORS);
}

/**
 * Check if mutation records contain relevant (message-related) changes.
 * Filters out composer mutations to prevent input lag.
 *
 * @param records MutationRecord array from observer
 * @returns true if any mutation is message-related
 */
export function hasRelevantMutation(records: MutationRecord[]): boolean {
  const composer = findComposer();

  for (const record of records) {
    const target = record.target;

    // Skip mutations inside composer
    if (composer && target instanceof Node && composer.contains(target)) {
      continue;
    }

    // Check added nodes for message indicators
    for (let i = 0; i < record.addedNodes.length; i++) {
      const node = record.addedNodes[i];
      if (node && isMessageish(node)) return true;
    }

    // Check removed nodes for message indicators
    for (let i = 0; i < record.removedNodes.length; i++) {
      const node = record.removedNodes[i];
      if (node && isMessageish(node)) return true;
    }

    // Check if target itself is a message or inside a message
    if (target instanceof HTMLElement) {
      if (target.matches(MESSAGE_INDICATOR_SELECTORS)) return true;
      if (target.closest?.(MESSAGE_INDICATOR_SELECTORS)) return true;
    }
  }

  return false;
}

// ============================================================================
// Observer Factories
// ============================================================================

/**
 * Create debounced MutationObserver with mutation filtering.
 * Batches rapid mutations into single callback invocation.
 * Ignores composer mutations to prevent input lag.
 */
export function createDebouncedObserver(
  callback: () => void,
  debounceMs: number = TIMING.DEBOUNCE_MS
): MutationObserver {
  let timeoutId: number | null = null;

  return new MutationObserver((records) => {
    // Filter: only react to message-related mutations
    if (!hasRelevantMutation(records)) {
      return;
    }

    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }

    timeoutId = window.setTimeout(() => {
      timeoutId = null;
      callback();
    }, debounceMs);
  });
}

/**
 * Create microtask-based MutationObserver for BOOT mode.
 * Uses queueMicrotask to coalesce mutations and execute before next paint.
 * Ignores composer mutations to prevent input lag.
 *
 * Key insight: MutationObserver callback already runs as microtask.
 * Using queueMicrotask inside coalesces multiple synchronous DOM changes
 * into a single trim evaluation, executing BEFORE the browser paints.
 *
 * Note: In BOOT mode, we're less strict about filtering since:
 * 1. User likely hasn't started typing yet
 * 2. We need to catch initial message rendering quickly
 * But we still filter composer mutations for safety.
 */
export function createMicrotaskObserver(callback: () => void): MutationObserver {
  let scheduled = false;

  return new MutationObserver((records) => {
    // Filter: only react to message-related mutations
    if (!hasRelevantMutation(records)) {
      return;
    }

    if (scheduled) {
      return;
    }

    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      callback();
    });
  });
}

/**
 * Create MutationObserver with adaptive scheduling based on trim mode
 */
export function createAdaptiveObserver(
  callback: () => void,
  mode: TrimMode
): MutationObserver {
  if (mode === 'BOOT') {
    return createMicrotaskObserver(callback);
  }
  return createDebouncedObserver(callback);
}

/**
 * Setup scroll tracking with throttling
 * Updates isAtBottom flag and triggers callback
 */
export function setupScrollTracking(
  scrollContainer: HTMLElement,
  onScrollChange: (isAtBottom: boolean) => void
): () => void {
  let lastCheckTime = 0;
  let rafId: number | null = null;

  const checkScroll = (): void => {
    const now = performance.now();
    if (now - lastCheckTime < TIMING.SCROLL_THROTTLE_MS) {
      return;
    }

    lastCheckTime = now;
    const isAtBottom = checkIsAtBottom(scrollContainer);
    onScrollChange(isAtBottom);
  };

  const throttledScroll = (): void => {
    if (rafId !== null) {
      return;
    }

    rafId = requestAnimationFrame(() => {
      rafId = null;
      checkScroll();
    });
  };

  scrollContainer.addEventListener('scroll', throttledScroll, { passive: true });

  // Initial check
  checkScroll();

  // Return cleanup function
  return () => {
    scrollContainer.removeEventListener('scroll', throttledScroll);
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
    }
  };
}

/**
 * Check if scroll container is at bottom
 */
function checkIsAtBottom(container: HTMLElement): boolean {
  // Handle document.documentElement (window scroll)
  if (container === document.documentElement) {
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollHeight = document.documentElement.scrollHeight;
    const clientHeight = window.innerHeight;

    const isAtBottom = scrollTop + clientHeight + DOM.BOTTOM_THRESHOLD_PX >= scrollHeight;
    logDebug(
      `checkIsAtBottom (window): ${isAtBottom} (${scrollTop + clientHeight} >= ${scrollHeight - DOM.BOTTOM_THRESHOLD_PX})`
    );
    return isAtBottom;
  }

  // Handle regular scrollable elements
  const { scrollTop, scrollHeight, clientHeight } = container;
  const isAtBottom = scrollTop + clientHeight + DOM.BOTTOM_THRESHOLD_PX >= scrollHeight;
  logDebug(
    `checkIsAtBottom: ${isAtBottom} (${scrollTop + clientHeight} >= ${scrollHeight - DOM.BOTTOM_THRESHOLD_PX})`
  );
  return isAtBottom;
}
