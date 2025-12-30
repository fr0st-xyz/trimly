/**
 * LightSession for ChatGPT - DOM Helpers
 * Role detection, visibility checks, node ID generation, and thread building
 */

import type { MsgRole, NodeInfo } from '../shared/types';
import { DOM } from '../shared/constants';
import { logDebug, logWarn } from '../shared/logger';
import { collectCandidates, collectCandidatesFast } from './selectors';

/**
 * Detect message role from DOM element
 * Uses data attributes, structural hints, and ARIA roles
 */
export function detectRole(el: HTMLElement): MsgRole {
  // Priority 1: Explicit data attributes
  const author = (
    el.dataset.messageAuthorRole ||
    el.dataset.messageAuthor ||
    el.dataset.role ||
    el.getAttribute('data-author') ||
    ''
  ).toLowerCase();

  if (/system/.test(author)) return 'system';
  if (/tool|function|plugin/.test(author)) return 'tool';
  if (/assistant|model|ai/.test(author)) return 'assistant';
  if (/user|you/.test(author)) return 'user';

  // Priority 2: conversation-turn data attributes
  const turnAttr = el.dataset.turn?.toLowerCase();
  if (turnAttr === 'user') return 'user';
  if (turnAttr === 'assistant') return 'assistant';
  if (turnAttr === 'system') return 'system';
  if (turnAttr === 'tool') return 'tool';

  // Priority 3: Structural/content-based indicators
  if (el.querySelector('[data-testid*="tool" i], [data-tool-call-id]')) {
    return 'tool';
  }

  if (el.querySelector('[data-testid*="copy" i], [data-testid*="regenerate" i]')) {
    return 'assistant';
  }

  // Priority 4: ARIA roles
  const role = el.getAttribute('role');
  if (role === 'status' || role === 'log' || role === 'alert') {
    return 'system';
  }

  // Default: unknown
  logDebug('Could not detect role for element:', el);
  return 'unknown';
}

/**
 * Check if element is visible
 */
export function isVisible(el: HTMLElement): boolean {
  // offsetParent is null if display:none or element is detached
  if (el.offsetParent === null) {
    return false;
  }

  // Check for zero bounding rects
  if (el.getClientRects().length === 0) {
    return false;
  }

  // Check for hidden ancestors
  if (el.closest('[hidden], [aria-hidden="true"]')) {
    return false;
  }

  return true;
}

/**
 * Check if element should be included in thread for trimming.
 *
 * IMPORTANT: content-visibility: auto (used for render optimization) causes
 * offscreen elements to return empty client rects from getClientRects().
 * Using isVisible() would exclude these elements, breaking trimming.
 *
 * For trusted ChatGPT message markers (data-turn, data-message-id), we only
 * check for explicit hiding (hidden attr, aria-hidden, display:none).
 * For other elements (Tier C fallback), we use full isVisible() check.
 */
export function shouldIncludeInThread(el: HTMLElement): boolean {
  // Fast path: trusted ChatGPT message markers
  // These elements ARE messages - only exclude if explicitly hidden
  // Note: we intentionally DON'T check offsetParent here because:
  // - offsetParent is null for position:fixed, display:contents, etc.
  // - Trusted markers are reliable enough to trust without layout checks
  if (el.dataset.turn || el.dataset.messageId) {
    // Only exclude if explicitly hidden via attributes
    if (el.closest('[hidden], [aria-hidden="true"]')) {
      return false;
    }
    return true;
  }

  // Fallback for non-trusted elements: use full visibility check
  return isVisible(el);
}

/**
 * Generate stable ID for a node
 * Prefers data-message-id, falls back to position + content hash
 */
export function getNodeId(el: HTMLElement, index: number): string {
  // Priority 1: data-message-id attribute
  if (el.dataset.messageId) {
    return el.dataset.messageId;
  }

  // Priority 2: Hash of position + content prefix
  const contentPrefix = el.textContent?.slice(0, 50) || '';
  return `msg-${index}-${simpleHash(contentPrefix)}`;
}

/**
 * Simple string hash function
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Find the conversation root element (scrollable container)
 * This is where MutationObserver will be attached
 */
export function findConversationRoot(): HTMLElement | null {
  // Try common conversation container selectors
  const selectors = [
    'main[class*="conversation" i]',
    '[role="main"]',
    'main',
    '[class*="thread" i]',
    '[class*="conversation" i]',
  ];

  for (const selector of selectors) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) {
      logDebug(`Found conversation root: ${selector}`);
      return el;
    }
  }

  logWarn('Could not find conversation root, falling back to document.body');
  return document.body;
}

// ============================================================================
// Narrower Messages Root (for Ultra Lean mode)
// ============================================================================

// Cache for messages root to avoid repeated DOM traversal
let messagesRootCache: HTMLElement | null = null;
let messagesRootCacheTime = 0;
const MESSAGES_ROOT_CACHE_TTL_MS = 5000;

// Selectors that indicate composer presence (we want to exclude these)
const COMPOSER_SELECTORS = [
  'form[class*="composer" i]',
  '[data-testid*="composer" i]',
  'textarea',
  '[contenteditable="true"]',
  '[role="textbox"]',
];

// Selectors to find message elements
const MESSAGE_SELECTORS = [
  '[data-message-id]',
  '[data-turn]',
  '[data-testid="conversation-turn"]',
  '[data-testid^="conversation-turn-"]',
].join(',');

/**
 * Find the narrowest container that holds only messages, excluding the composer.
 * This provides a more focused observation target to reduce MutationObserver noise
 * when typing in the composer.
 *
 * Strategy:
 * 1. Find first message element as anchor
 * 2. Walk up the DOM tree
 * 3. Stop at the last container that doesn't include a composer
 * 4. Require at least 2 messages to validate the container
 *
 * Falls back to findConversationRoot() if unable to isolate messages.
 */
export function findMessagesRoot(): HTMLElement | null {
  // Return cached result if still valid
  const now = performance.now();
  if (messagesRootCache && now - messagesRootCacheTime < MESSAGES_ROOT_CACHE_TTL_MS) {
    // Verify cache is still in DOM
    if (messagesRootCache.isConnected) {
      return messagesRootCache;
    }
    // Cache is stale, clear it
    messagesRootCache = null;
  }

  // Find first message to anchor our search
  const firstMessage = document.querySelector<HTMLElement>(MESSAGE_SELECTORS);

  if (!firstMessage) {
    logDebug('findMessagesRoot: No message found, falling back to findConversationRoot');
    return findConversationRoot();
  }

  // Walk up from first message, find narrowest container without composer
  let candidate: HTMLElement | null = firstMessage.parentElement;
  let messagesRoot: HTMLElement | null = null;

  // Limit traversal depth to prevent infinite loops
  const MAX_DEPTH = 15;
  let depth = 0;

  while (candidate && candidate !== document.body && depth < MAX_DEPTH) {
    depth++;

    // Check if this candidate contains a composer
    const hasComposer = COMPOSER_SELECTORS.some(sel => candidate?.querySelector(sel));

    if (hasComposer) {
      // This container includes composer, use previous candidate (if any)
      logDebug(`findMessagesRoot: Found composer at depth ${depth}, using previous candidate`);
      break;
    }

    // Check if candidate has multiple messages (validates it's a good container)
    const messageCount = candidate.querySelectorAll(MESSAGE_SELECTORS).length;

    if (messageCount >= 2) {
      // Remove attribute from previous candidate to avoid multiple marked elements
      if (messagesRoot && messagesRoot !== candidate) {
        messagesRoot.removeAttribute('data-ls-messages-root');
      }
      messagesRoot = candidate;
      // Mark the element for CSS targeting
      messagesRoot.setAttribute('data-ls-messages-root', '1');
    }

    candidate = candidate.parentElement;
  }

  if (messagesRoot) {
    logDebug(`findMessagesRoot: Found container with ${messagesRoot.querySelectorAll(MESSAGE_SELECTORS).length} messages at depth ${depth}`);
    messagesRootCache = messagesRoot;
    messagesRootCacheTime = now;
    return messagesRoot;
  }

  // Fallback to full conversation root
  logDebug('findMessagesRoot: Could not isolate messages, using findConversationRoot');
  return findConversationRoot();
}

/**
 * Invalidate the messages root cache.
 * Call this on navigation or when settings change.
 * Also invalidates the shallow observer capability cache.
 */
export function invalidateMessagesRootCache(): void {
  if (messagesRootCache) {
    messagesRootCache.removeAttribute('data-ls-messages-root');
  }
  messagesRootCache = null;
  messagesRootCacheTime = 0;

  // Also invalidate shallow capable cache since it depends on messages root
  shallowCapableCache = null;
  shallowCapableCacheTime = 0;

  logDebug('Messages root cache invalidated');
}

/**
 * Check if a root element has messages as direct children.
 * Used to determine if shallow observation (subtree: false) is possible.
 *
 * @param root The container element to check
 * @returns true if at least 2 message elements are direct children of root
 */
export function hasDirectMessageChildren(root: HTMLElement): boolean {
  let directMessageCount = 0;

  for (const child of Array.from(root.children)) {
    if (child instanceof HTMLElement && child.matches(MESSAGE_SELECTORS)) {
      directMessageCount++;
      if (directMessageCount >= 2) {
        return true;
      }
    }
  }

  return false;
}

// Cache for shallow observer capability check
let shallowCapableCache: boolean | null = null;
let shallowCapableCacheTime = 0;
const SHALLOW_CAPABLE_CACHE_TTL_MS = 5000;

/**
 * Check if shallow observation is possible for the current messages root.
 * Returns true if messagesRoot has messages as direct children,
 * meaning we can use subtree: false to reduce observer noise.
 *
 * Results are cached for 5 seconds to avoid repeated DOM traversal.
 * Cache is invalidated when messages root cache is invalidated.
 */
export function canUseShallowObserver(): boolean {
  const now = performance.now();

  // Return cached result if still valid
  if (shallowCapableCache !== null && now - shallowCapableCacheTime < SHALLOW_CAPABLE_CACHE_TTL_MS) {
    return shallowCapableCache;
  }

  const root = findMessagesRoot();
  if (!root) {
    shallowCapableCache = false;
    shallowCapableCacheTime = now;
    return false;
  }

  const canShallow = hasDirectMessageChildren(root);
  shallowCapableCache = canShallow;
  shallowCapableCacheTime = now;

  logDebug(`canUseShallowObserver: ${canShallow} (messages are ${canShallow ? 'direct' : 'nested'} children)`);
  return canShallow;
}

/**
 * Invalidate the shallow observer capability cache.
 * Called together with messages root cache invalidation.
 */
export function invalidateShallowCapableCache(): void {
  shallowCapableCache = null;
  shallowCapableCacheTime = 0;
}

/**
 * Find the scrollable ancestor of an element
 */
export function findScrollableAncestor(el: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = el;

  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    const overflow = style.overflow + style.overflowY + style.overflowX;

    if (/(auto|scroll)/.test(overflow) && current.scrollHeight > current.clientHeight) {
      logDebug('Found scrollable ancestor:', current);
      return current;
    }

    current = current.parentElement;
  }

  // Fallback to window scroll
  logDebug('No scrollable ancestor found, using document.documentElement');
  return document.documentElement;
}

// Cache scroller to avoid repeated findScrollableAncestor calls
let cachedScroller: HTMLElement | null = null;
let scrollerCacheTime = 0;
const SCROLLER_CACHE_TTL_MS = 3000;

/**
 * Check if user is near the bottom of the scrollable area.
 * Used to enable fast-path trimming without layout reads.
 *
 * When near bottom, user is likely actively chatting, so:
 * - Use count-based trim (no layout reads)
 * - Skip visibility checks
 * - Prioritize responsiveness over precision
 *
 * @param root Optional root element to find scroller from
 * @returns true if within ~2 viewports of bottom
 */
export function isNearBottom(root?: HTMLElement | null): boolean {
  const now = performance.now();

  // Use cached scroller if valid
  let scroller = cachedScroller;
  if (!scroller || now - scrollerCacheTime > SCROLLER_CACHE_TTL_MS || !scroller.isConnected) {
    const anchor = root ?? document.body;
    scroller = findScrollableAncestor(anchor);
    cachedScroller = scroller;
    scrollerCacheTime = now;
  }

  if (!scroller) return true; // Assume near bottom if no scroller

  // Calculate remaining scroll distance
  const remaining = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);

  // "Near bottom" = within 2 viewport heights
  // This gives buffer for smooth experience while user types
  return remaining < scroller.clientHeight * 2;
}

/**
 * Invalidate scroller cache (call on navigation).
 */
export function invalidateScrollerCache(): void {
  cachedScroller = null;
  scrollerCacheTime = 0;
}

/**
 * Build NodeInfo array for active thread
 * Filters visible nodes, assigns roles and IDs
 *
 * Note: We trust DOM order instead of Y-coordinate sorting because:
 * 1. NodeList from querySelectorAll is already in document order
 * 2. content-visibility: auto breaks getBoundingClientRect() for offscreen elements
 * 3. DOM order is more reliable and doesn't trigger layout
 *
 * @param root Optional root element to scope queries (defaults to document)
 *             When provided, queries are faster as they search smaller DOM subtree
 */
export function buildActiveThread(root?: ParentNode): NodeInfo[] {
  const { nodes, tier } = collectCandidates(root);

  if (nodes.length < DOM.MIN_CANDIDATES) {
    logDebug(`buildActiveThread: Not enough candidates (${nodes.length})`);
    return [];
  }

  // Build NodeInfo array - trust DOM order, no Y-sorting needed
  // Use shouldIncludeInThread instead of isVisible to handle content-visibility: auto
  // which makes offscreen elements return empty client rects
  const nodeInfos: NodeInfo[] = nodes.filter(shouldIncludeInThread).map((node, index) => ({
    node,
    role: detectRole(node),
    id: getNodeId(node, index),
    y: index, // Use index as pseudo-Y (DOM order is correct)
    visible: true,
  }));

  logDebug(`buildActiveThread: Built thread with ${nodeInfos.length} nodes (tier ${tier})`);

  return nodeInfos;
}

/**
 * Layout-read-free version of buildActiveThread for BOOT mode.
 * Avoids getBoundingClientRect, isVisible, and other layout-triggering calls.
 * Trusts DOM order instead of visual order (Y-coordinate sorting).
 *
 * This is critical for pre-paint trimming where layout reads would
 * force the browser to compute layout before we can trim, defeating
 * the purpose of BOOT mode.
 *
 * Trade-offs:
 * - Less accurate: may include hidden elements or wrong order
 * - Much faster: no forced layout/reflow
 * - For BOOT mode, speed is more important than perfect accuracy
 *
 * @param root Optional root element to scope queries (defaults to document)
 *             When provided, queries are faster as they search smaller DOM subtree
 */
export function buildActiveThreadFast(root?: ParentNode): NodeInfo[] {
  const { nodes, tier } = collectCandidatesFast(root);

  if (nodes.length < DOM.MIN_CANDIDATES) {
    logDebug(`buildActiveThreadFast: Not enough candidates (${nodes.length})`);
    return [];
  }

  // Build NodeInfo array without layout reads
  // Trust DOM order - no Y-coordinate sorting
  // Y is set to index for ordering (avoids getBoundingClientRect)
  const nodeInfos: NodeInfo[] = nodes.map((node, index) => ({
    node,
    role: detectRole(node),
    id: getNodeId(node, index),
    y: index, // Use index as pseudo-Y to maintain DOM order
    visible: true, // Assume visible (skip isVisible check)
  }));

  logDebug(`buildActiveThreadFast: Built thread with ${nodeInfos.length} nodes (tier ${tier})`);

  return nodeInfos;
}
