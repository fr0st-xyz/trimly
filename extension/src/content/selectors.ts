/**
 * LightSession for ChatGPT - Selector Strategies
 * Multi-tier selector system for DOM resilience with caching
 */

import type { SelectorTierName } from '../shared/types';
import { SELECTOR_TIERS, DOM } from '../shared/constants';
import { logDebug, logWarn } from '../shared/logger';
import { isVisible } from './dom-helpers';

// ============================================================================
// Selector Cache (Performance Optimization)
// ============================================================================

/**
 * Cache entry for selector results
 */
interface SelectorCache {
  nodes: HTMLElement[];
  tier: SelectorTierName | null;
  timestamp: number;
  epoch: number; // Cache generation - entries with old epoch are invalid
}

/**
 * Cache TTL in milliseconds.
 * 100ms provides good balance: reduces DOM queries during debounce
 * window while ensuring relatively fresh data.
 */
const CACHE_TTL_MS = 100;

/**
 * Cache epoch (generation counter).
 * Incrementing this instantly invalidates all cached entries without
 * needing to clear the WeakMap (which is impossible).
 */
let cacheEpoch = 0;

/**
 * Per-root cache using WeakMap.
 * WeakMap allows GC of cache entries when root elements are removed from DOM.
 * This prevents memory leaks during SPA navigation.
 */
const rootCacheMap = new WeakMap<ParentNode, SelectorCache>();

/**
 * Document-level cache (for when no root is specified)
 * Stored separately since Document is not a valid WeakMap key in all contexts
 */
let documentCache: SelectorCache | null = null;

/**
 * Invalidate the selector cache for a specific root or all caches.
 * Called when DOM changes significantly (e.g., navigation).
 *
 * @param root Optional root to invalidate. If not provided, invalidates document cache.
 */
export function invalidateSelectorCache(root?: ParentNode): void {
  // Document or no root - clear the document-level cache
  if (!root || root === document) {
    documentCache = null;
    logDebug('Document selector cache invalidated');
    return;
  }
  // Specific root - clear from WeakMap
  rootCacheMap.delete(root);
  logDebug('Root selector cache invalidated');
}

/**
 * Invalidate all selector caches (document + all roots).
 * Uses epoch increment to instantly invalidate all WeakMap entries
 * without needing to clear them (which is impossible).
 */
export function invalidateAllSelectorCaches(): void {
  cacheEpoch++; // Instantly invalidates ALL cached entries
  documentCache = null;
  logDebug('All selector caches invalidated (epoch++)');
}

/**
 * Check if a cache entry is valid (correct epoch and not expired)
 */
function isCacheEntryValid(entry: SelectorCache | null | undefined): entry is SelectorCache {
  if (!entry) return false;
  if (entry.epoch !== cacheEpoch) return false; // Stale epoch
  const age = performance.now() - entry.timestamp;
  return age < CACHE_TTL_MS;
}

/**
 * Get cached result for a root, if valid
 */
function getCachedResult(root: ParentNode | undefined): SelectorCache | null {
  if (!root || root === document) {
    return isCacheEntryValid(documentCache) ? documentCache : null;
  }
  const cached = rootCacheMap.get(root);
  return isCacheEntryValid(cached) ? cached : null;
}

/**
 * Store result in cache (automatically stamps with current epoch)
 */
function setCachedResult(
  root: ParentNode | undefined,
  result: Omit<SelectorCache, 'epoch'>
): void {
  const entry: SelectorCache = { ...result, epoch: cacheEpoch };
  if (!root || root === document) {
    documentCache = entry;
  } else {
    rootCacheMap.set(root, entry);
  }
}

/**
 * Filter to keep only outermost elements, removing any nested descendants.
 *
 * IMPORTANT: ChatGPT DOM may have nested elements with data-message-id or data-turn
 * (e.g., message container AND inner content both have attributes).
 * We must only trim the outermost container to avoid removing message content
 * while leaving headers/thinking indicators.
 *
 * Algorithm: For each element, check if any OTHER element in the list contains it.
 * If so, exclude it (it's a nested child of another matched element).
 */
function filterToOutermostElements(elements: HTMLElement[]): HTMLElement[] {
  if (elements.length <= 1) {
    return elements;
  }

  // Create a Set for O(1) lookup
  const elementSet = new Set(elements);

  return elements.filter((el) => {
    // Walk up the DOM tree to check if any ancestor is also in our list
    let parent = el.parentElement;
    while (parent) {
      if (elementSet.has(parent)) {
        // This element is nested inside another matched element - exclude it
        return false;
      }
      parent = parent.parentElement;
    }
    // No ancestor in the list - this is an outermost element
    return true;
  });
}

// ============================================================================
// Main Selector Function
// ============================================================================

/**
 * Collect candidate message nodes using multi-tier selector strategy
 * Tries Tier A first, falls back to B, then C
 *
 * Uses per-root caching with 100ms TTL to reduce DOM queries during rapid
 * evaluation cycles (e.g., within debounce window).
 *
 * @param root Optional root element to scope queries (defaults to document)
 *             When provided, queries are faster as they search smaller DOM subtree
 * @returns Object containing nodes array and tier used (or null if all tiers failed)
 */
export function collectCandidates(root?: ParentNode): { nodes: HTMLElement[]; tier: SelectorTierName | null } {
  // Return cached result if valid (works for both document and scoped roots)
  const cached = getCachedResult(root);
  if (cached) {
    logDebug('collectCandidates: Using cached result');
    return { nodes: cached.nodes, tier: cached.tier };
  }

  const queryRoot = root ?? document;
  const scopeLabel = root ? '[scoped]' : '';
  logDebug(`collectCandidates${scopeLabel}: Starting selector tier search...`);

  for (const tier of SELECTOR_TIERS) {
    // Query all selectors for this tier and de-duplicate
    const nodes = [
      ...new Set(
        tier.selectors.flatMap((sel) => Array.from(queryRoot.querySelectorAll<HTMLElement>(sel)))
      ),
    ];

    logDebug(`Tier ${tier.name}: Found ${nodes.length} raw nodes before filtering`);

    // Filter using heuristics (especially important for Tier C)
    const filtered = nodes.filter(isLikelyMessage);

    logDebug(`Tier ${tier.name}: ${filtered.length} nodes after isLikelyMessage filter`);

    // Filter to outermost elements only - avoid trimming nested content
    const outermost = filterToOutermostElements(filtered);

    logDebug(`Tier ${tier.name}: ${outermost.length} nodes after outermost filter`);

    // Accept tier if we have enough candidates
    // Note: We trust DOM order (NodeList is already in document order)
    // No Y-coordinate validation needed - it breaks with content-visibility: auto
    if (outermost.length >= tier.minCandidates) {
      logDebug(
        `Using selector tier ${tier.name} (${tier.description}): ${outermost.length} candidates`
      );
      // Cache the result (per-root cache)
      const result = { nodes: outermost, tier: tier.name, timestamp: performance.now() };
      setCachedResult(root, result);
      return { nodes: outermost, tier: tier.name };
    }

    logDebug(
      `Tier ${tier.name} failed: ${filtered.length} candidates (min: ${tier.minCandidates})`
    );
  }

  // Fallback: probe for data-testid based ChatGPT DOM patterns (post 2024 UI)
  const fallbackSelectors = [
    '[data-testid="conversation-turn"]',
    '[data-testid^="conversation-turn-"]',
    '[data-testid="assistant-turn"]',
    '[data-testid="user-turn"]',
    'div[class*="conversation-turn" i] article',
    'section[aria-label*="chat history" i] article'
  ];

  const fallbackFiltered = [
    ...new Set(
      fallbackSelectors.flatMap((selector) =>
        Array.from(queryRoot.querySelectorAll<HTMLElement>(selector))
      )
    ),
  ].filter(isLikelyMessage);

  // Filter to outermost elements only
  const fallbackNodes = filterToOutermostElements(fallbackFiltered);

  if (fallbackNodes.length >= DOM.MIN_CANDIDATES) {
    logDebug(
      'Fallback selectors succeeded: ' +
        fallbackNodes.length +
        ' candidates using data-testid heuristics'
    );
    // Cache the fallback result (per-root cache)
    const result = { nodes: fallbackNodes, tier: null, timestamp: performance.now() };
    setCachedResult(root, result);
    return { nodes: fallbackNodes, tier: null };
  }

  logWarn('All selector tiers failed to find valid candidates');
  // Cache empty result to avoid repeated queries when no candidates found (per-root cache)
  const emptyResult = { nodes: [] as HTMLElement[], tier: null, timestamp: performance.now() };
  setCachedResult(root, emptyResult);
  return { nodes: [], tier: null };
}

/**
 * Heuristic to determine if an element is likely a message node.
 * Used primarily for Tier C filtering when semantic selectors fail.
 *
 * Heuristic thresholds explained:
 * - 500 descendants: Page containers (body, main) have 1000+ elements.
 *   Individual messages rarely exceed 200-300 (code blocks, images).
 *   500 provides safety margin while catching misselected containers.
 *
 * - 50px height: Messages include avatar (~40px) + at least one line of text.
 *   Minimum realistic height is ~50-60px. Excludes tiny buttons, badges.
 *
 * - 10 characters: Excludes empty containers, icon-only elements.
 *   Shortest real message might be "Hi" (2 chars) but with UI text
 *   (timestamps, "Copy", etc.) actual textContent is typically 10+.
 *
 * These heuristics are defensive fallbacks. Prefer Tier A/B selectors
 * which use data attributes and have near-zero false positive rate.
 */
function isLikelyMessage(el: HTMLElement): boolean {
  // Fast path: ChatGPT conversation containers expose data-turn with roles
  // This is the most reliable indicator when available
  if (el.dataset.turn) {
    return isVisible(el);
  }

  // Must be visible (basic check)
  if (!isVisible(el)) {
    return false;
  }

  // Exclude critical page elements by tag first (most important check)
  // These elements would break the page if removed
  const tagName = el.tagName.toLowerCase();
  if (tagName === 'main' || tagName === 'nav' || tagName === 'header' || tagName === 'footer' || tagName === 'body') {
    return false;
  }

  // Safety check: Don't select elements with too many descendants (page containers)
  // Only apply this to elements with suspiciously many children
  // Threshold: 500 elements (messages rarely exceed 200-300)
  const descendantCount = el.querySelectorAll('*').length;
  if (descendantCount > 500) {
    return false; // Definitely a major container
  }

  // Must have reasonable height (messages are typically >50px)
  // Messages include avatar + text, minimum ~50-60px
  const rect = el.getBoundingClientRect();
  if (rect.height < 50) {
    return false;
  }

  // Must contain some text content
  // Threshold: 10 chars excludes empty containers, icon-only elements
  const text = el.textContent?.trim() || '';
  if (text.length < 10) {
    return false;
  }

  // Exclude elements that are clearly not messages based on class names
  const classList = el.className.toLowerCase();
  if (
    classList.includes('header') ||
    classList.includes('footer') ||
    classList.includes('sidebar') ||
    classList.includes('menu')
  ) {
    return false;
  }

  return true;
}

/**
 * Layout-read-free version of isLikelyMessage for BOOT mode.
 * Avoids getBoundingClientRect, isVisible, querySelectorAll, and other slow calls.
 * Only O(1) attribute checks - critical for pre-paint trimming.
 *
 * Trade-off: Less accurate but much faster. For BOOT mode, speed > accuracy.
 */
function isLikelyMessageFast(el: HTMLElement): boolean {
  // Fast path: ChatGPT data attributes are the most reliable indicators
  // These are O(1) lookups and nearly always correct
  if (el.dataset.turn || el.dataset.messageId) {
    // Quick hidden check (no layout read)
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    return true;
  }

  // For elements without data attributes, apply minimal filtering
  // Skip hidden elements
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') {
    return false;
  }

  // Exclude critical page elements by tag (O(1))
  const tagName = el.tagName.toLowerCase();
  if (tagName === 'main' || tagName === 'nav' || tagName === 'header' || tagName === 'footer' || tagName === 'body') {
    return false;
  }

  // Exclude elements by class names (O(1) string check)
  const classList = el.className.toLowerCase();
  if (
    classList.includes('header') ||
    classList.includes('footer') ||
    classList.includes('sidebar') ||
    classList.includes('menu')
  ) {
    return false;
  }

  // Note: Removed querySelectorAll('*').length check - it's O(n) and too slow for BOOT
  // Note: Removed textContent check - it can be slow for large elements

  return true;
}


/**
 * Layout-read-free version of collectCandidates for BOOT mode.
 * Skips Y-coordinate validation and uses fast heuristics.
 * Trusts DOM order instead of visual order.
 *
 * This is critical for pre-paint trimming where layout reads would
 * force the browser to compute layout before we can trim.
 *
 * @param root Optional root element to scope queries (defaults to document)
 *             When provided, queries are faster as they search smaller DOM subtree
 */
export function collectCandidatesFast(root?: ParentNode): { nodes: HTMLElement[]; tier: SelectorTierName | null } {
  const queryRoot = root ?? document;
  const scopeLabel = root ? '[scoped]' : '';
  logDebug(`collectCandidatesFast${scopeLabel}: Starting layout-read-free selector search...`);

  for (const tier of SELECTOR_TIERS) {
    // Query all selectors for this tier and de-duplicate
    const nodes = [
      ...new Set(
        tier.selectors.flatMap((sel) => Array.from(queryRoot.querySelectorAll<HTMLElement>(sel)))
      ),
    ];

    logDebug(`Tier ${tier.name} [fast]: Found ${nodes.length} raw nodes`);

    // Filter using fast heuristics (no layout reads)
    const filtered = nodes.filter(isLikelyMessageFast);

    logDebug(`Tier ${tier.name} [fast]: ${filtered.length} nodes after fast filter`);

    // Filter to outermost elements only - avoid trimming nested content
    const outermost = filterToOutermostElements(filtered);

    logDebug(`Tier ${tier.name} [fast]: ${outermost.length} nodes after outermost filter`);

    // Accept if we have enough candidates (skip Y-coordinate validation)
    if (outermost.length >= tier.minCandidates) {
      logDebug(
        `Using selector tier ${tier.name} [fast] (${tier.description}): ${outermost.length} candidates`
      );
      return { nodes: outermost, tier: tier.name };
    }
  }

  // Fallback selectors
  const fallbackSelectors = [
    '[data-testid="conversation-turn"]',
    '[data-testid^="conversation-turn-"]',
    '[data-testid="assistant-turn"]',
    '[data-testid="user-turn"]',
  ];

  const fallbackFiltered = [
    ...new Set(
      fallbackSelectors.flatMap((selector) =>
        Array.from(queryRoot.querySelectorAll<HTMLElement>(selector))
      )
    ),
  ].filter(isLikelyMessageFast);

  // Filter to outermost elements only
  const fallbackNodes = filterToOutermostElements(fallbackFiltered);

  if (fallbackNodes.length >= DOM.MIN_CANDIDATES) {
    logDebug(`Fallback [fast]: ${fallbackNodes.length} candidates`);
    return { nodes: fallbackNodes, tier: null };
  }

  logDebug('collectCandidatesFast: No candidates found');
  return { nodes: [], tier: null };
}

// Note: isSequenceValid() was removed because:
// 1. content-visibility: auto breaks getBoundingClientRect() for offscreen elements
// 2. DOM order (NodeList) is already correct - no need for Y-coordinate validation
// 3. This eliminates Y-coordinate warnings and improves performance
