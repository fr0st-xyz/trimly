/**
 * LightSession for ChatGPT - Page Script (Fetch Proxy)
 *
 * This script runs in the page context (not content script isolated world).
 * It patches window.fetch to intercept ChatGPT API responses and trim
 * conversation data BEFORE React renders it.
 *
 * Benefits over DOM manipulation:
 * - No flash of untrimmed content
 * - No MutationObserver overhead
 * - Simpler, more reliable
 */

// Make this file a module for global augmentation to work
export {};

// ============================================================================
// Types
// ============================================================================

interface LsConfig {
  enabled: boolean;
  limit: number;
  debug: boolean;
}

interface ChatMessage {
  author?: {
    role?: string;
  };
}

interface ChatNode {
  parent: string | null;
  children?: string[];
  message?: ChatMessage;
}

interface ChatMapping {
  [nodeId: string]: ChatNode;
}

interface ConversationData {
  mapping?: ChatMapping;
  current_node?: string;
  root?: string;
}

interface TrimResult {
  mapping: ChatMapping;
  current_node: string;
  root: string;
  keptCount: number;
  totalCount: number;
  visibleKept: number;
  visibleTotal: number;
}

interface TrimStatus {
  totalBefore: number;
  keptAfter: number;
  removed: number;
  limit: number;
}

// ============================================================================
// Global State
// ============================================================================

declare global {
  interface Window {
    __LS_CONFIG__?: LsConfig;
    __LS_PROXY_PATCHED__?: boolean;
    __LS_DEBUG__?: boolean;
  }
}

const DEFAULT_CONFIG: LsConfig = {
  enabled: true,
  limit: 10,
  debug: false,
};

// ============================================================================
// Logging
// ============================================================================

function log(...args: unknown[]): void {
  if (window.__LS_DEBUG__) {
    console.log('[LS:PageScript]', ...args);
  }
}

// ============================================================================
// Trimming Logic
// ============================================================================

/**
 * Trim conversation mapping to keep only the last N messages in the thread.
 *
 * Algorithm:
 * 1. Start from current_node, walk up via parent links to build the full path
 * 2. Reverse to get chronological order (oldest first)
 * 3. Keep only the last `limit` nodes
 * 4. Rebuild mapping with only kept nodes, fixing parent/children links
 */
/**
 * Roles that are NOT visible to users (hidden/internal).
 * Everything else (user, assistant, etc.) is considered visible.
 */
const HIDDEN_ROLES = new Set([
  'system',    // System prompts
  'tool',      // Tool/function calls
  'thinking',  // Extended Thinking internal nodes
]);

/**
 * Check if a node is a visible message.
 * A node is visible if it has a message with an author role that is NOT in HIDDEN_ROLES.
 * Nodes without messages (like root nodes) are not visible.
 */
function isVisibleMessage(node: ChatNode): boolean {
  const role = node.message?.author?.role;
  // Must have a role to be considered a message
  if (!role) return false;
  // Exclude hidden/internal roles
  return !HIDDEN_ROLES.has(role);
}

function trimMapping(data: ConversationData, limit: number): TrimResult | null {
  const mapping = data.mapping;
  const currentNode = data.current_node;

  if (!mapping || !currentNode || !mapping[currentNode]) {
    return null;
  }

  // Build path from current_node to root by following parent links
  const path: string[] = [];
  let cursor: string | null = currentNode;
  const visited = new Set<string>();

  while (cursor) {
    const node: ChatNode | undefined = mapping[cursor];
    if (!node || visited.has(cursor)) {
      break;
    }
    visited.add(cursor);
    path.push(cursor);
    cursor = node.parent ?? null;
  }

  // Reverse to chronological order (oldest first)
  path.reverse();

  const totalCount = path.length;
  const effectiveLimit = Math.max(1, limit);

  // Count total TURNS (role transitions) and collect role statistics
  let visibleTotal = 0;
  let lastVisibleRole: string | null = null;
  const roleCounts: Record<string, number> = {};
  for (const nodeId of path) {
    const node = mapping[nodeId];
    const role = node?.message?.author?.role ?? '(no role)';
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;
    if (node && isVisibleMessage(node)) {
      // Count turns, not individual nodes
      if (role !== lastVisibleRole) {
        visibleTotal++;
        lastVisibleRole = role;
      }
    }
  }
  // Always log roles for diagnostics (bypasses debug flag)
  console.log('[LS:PageScript] Roles in path:', roleCounts, '| turns:', visibleTotal, '/', totalCount, 'nodes');

  // Find cut point by counting TURNS (role transitions), not individual nodes
  // A turn is a contiguous sequence of messages from the same role
  // This matches how ChatGPT renders messages (multiple nodes = 1 bubble)
  let turnCount = 0;
  let cutIndex = 0;
  let lastRole: string | null = null;

  for (let i = path.length - 1; i >= 0; i--) {
    const nodeId = path[i];
    if (!nodeId) continue;

    const node = mapping[nodeId];
    if (node && isVisibleMessage(node)) {
      const role = node.message?.author?.role ?? '';
      // Count turn when role changes (or first visible message)
      if (role !== lastRole) {
        turnCount++;
        lastRole = role;
      }
      if (turnCount >= effectiveLimit) {
        cutIndex = i;
        break;
      }
    }
  }

  const keptRaw = path.slice(cutIndex);

  // Filter to ONLY user/assistant nodes (remove system/tool that got included)
  const kept = keptRaw.filter(id => {
    const node = mapping[id];
    return node && isVisibleMessage(node);
  });

  if (kept.length === 0) {
    return null;
  }

  // Build new mapping with only kept nodes
  const newMapping: ChatMapping = {};
  let turnsKept = 0;
  let prevRole: string | null = null;

  for (let i = 0; i < kept.length; i++) {
    const id = kept[i];
    if (!id) continue;

    const prevId = kept[i - 1] ?? null;
    const nextId = kept[i + 1] ?? null;
    const originalNode = mapping[id];

    if (originalNode) {
      newMapping[id] = {
        ...originalNode,
        parent: prevId,
        children: nextId ? [nextId] : [],
      };
      // Count turns (role transitions) for accurate display
      const role = originalNode.message?.author?.role ?? '';
      if (role !== prevRole && isVisibleMessage(originalNode)) {
        turnsKept++;
        prevRole = role;
      }
    }
  }

  const visibleKept = turnsKept;

  const newRoot = kept[0];
  const newCurrentNode = kept[kept.length - 1];

  // These should always be defined since kept.length > 0, but TypeScript needs assurance
  if (!newRoot || !newCurrentNode) {
    return null;
  }

  // Always log trim result for diagnostics
  const keptRoles: Record<string, number> = {};
  for (const id of kept) {
    const node = mapping[id];
    const role = node?.message?.author?.role ?? '(no role)';
    keptRoles[role] = (keptRoles[role] ?? 0) + 1;
  }
  console.log('[LS:PageScript] Kept roles:', keptRoles, '| visible kept:', visibleKept);

  return {
    mapping: newMapping,
    current_node: newCurrentNode,
    root: newRoot,
    keptCount: kept.length,
    totalCount,
    visibleKept,
    visibleTotal,
  };
}

// ============================================================================
// Status Dispatch
// ============================================================================

/**
 * Dispatch trim status to content script via CustomEvent.
 * Content script listens for this to update the status bar.
 */
function dispatchStatus(status: TrimStatus): void {
  window.dispatchEvent(
    new CustomEvent('lightsession-status', { detail: status })
  );
}

// ============================================================================
// Fetch Proxy
// ============================================================================

/**
 * Get current config (with defaults)
 */
function getConfig(): LsConfig {
  const cfg = window.__LS_CONFIG__;
  return {
    enabled: cfg?.enabled ?? DEFAULT_CONFIG.enabled,
    limit: Math.max(1, cfg?.limit ?? DEFAULT_CONFIG.limit),
    debug: cfg?.debug ?? DEFAULT_CONFIG.debug,
  };
}

/**
 * Check if this is a conversation API request we should intercept
 */
function isConversationRequest(req: Request, url: URL): boolean {
  // Only GET requests
  if (req.method !== 'GET') {
    return false;
  }

  // Only /backend-api/ endpoints
  if (!url.pathname.startsWith('/backend-api/')) {
    return false;
  }

  return true;
}

/**
 * Check if response is JSON
 */
function isJsonResponse(res: Response): boolean {
  const contentType = res.headers.get('content-type') || '';
  return contentType.toLowerCase().includes('application/json');
}

/**
 * Create a new Response with modified JSON body
 */
function createModifiedResponse(
  originalRes: Response,
  modifiedData: ConversationData
): Response {
  const text = JSON.stringify(modifiedData);

  // Clone headers but remove content-length (will be recalculated)
  const headers = new Headers(originalRes.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json; charset=utf-8');

  const response = new Response(text, {
    status: originalRes.status,
    statusText: originalRes.statusText,
    headers,
  });

  // Preserve url and type properties
  try {
    if (originalRes.url) {
      Object.defineProperty(response, 'url', { value: originalRes.url });
    }
    if (originalRes.type) {
      Object.defineProperty(response, 'type', { value: originalRes.type });
    }
  } catch {
    // Ignore if properties can't be set
  }

  return response;
}

/**
 * Main fetch interceptor
 */
async function interceptedFetch(
  nativeFetch: typeof fetch,
  ...args: Parameters<typeof fetch>
): Promise<Response> {
  const cfg = getConfig();
  const res = await nativeFetch(...args);

  // Skip if disabled
  if (!cfg.enabled) {
    return res;
  }

  try {
    // Check if this is a request we should intercept
    const req = new Request(...args);
    const url = new URL(req.url, location.href);

    if (!isConversationRequest(req, url)) {
      return res;
    }

    if (!isJsonResponse(res)) {
      return res;
    }

    // Clone and parse response
    const clone = res.clone();
    const json = (await clone.json().catch(() => null)) as ConversationData | null;

    if (!json || typeof json !== 'object') {
      return res;
    }

    // Check if this looks like conversation data
    if (!json.mapping || !json.current_node) {
      return res;
    }

    // Trim the mapping
    const trimmed = trimMapping(json, cfg.limit);

    if (!trimmed) {
      return res;
    }

    // Calculate statistics (based on visible messages for user-friendly display)
    const totalBefore = trimmed.visibleTotal;
    const keptAfter = trimmed.visibleKept;
    const removed = Math.max(0, totalBefore - keptAfter);

    log(
      `Trimmed: ${keptAfter}/${totalBefore} nodes (limit: ${cfg.limit}), visible: ${trimmed.visibleKept}/${trimmed.visibleTotal}`
    );

    // Dispatch status to content script
    dispatchStatus({
      totalBefore,
      keptAfter,
      removed,
      limit: cfg.limit,
    });

    // Build modified response data
    const modifiedData: ConversationData = {
      ...json,
      mapping: trimmed.mapping,
      current_node: trimmed.current_node,
    };

    // Preserve root if it was in original data
    if ('root' in json) {
      modifiedData.root = trimmed.root;
    }

    return createModifiedResponse(res, modifiedData);
  } catch (error) {
    // On any error, return original response
    log('Error in fetch interceptor:', error);
    return res;
  }
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Patch window.fetch with our interceptor
 */
function patchFetch(): void {
  // Prevent double-patching
  if (window.__LS_PROXY_PATCHED__) {
    log('Already patched, skipping');
    return;
  }

  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    return interceptedFetch(nativeFetch, ...args);
  };

  window.__LS_PROXY_PATCHED__ = true;
  log('Fetch proxy installed');

  // Notify content script that proxy is ready (use origin for security)
  window.postMessage({ type: 'lightsession-proxy-ready' }, location.origin);

  // Request config from content script (handles race condition where
  // content script may have loaded before page script sent ready signal)
  window.dispatchEvent(new CustomEvent('lightsession-request-config'));
}

/**
 * Listen for config updates from content script
 */
function setupConfigListener(): void {
  window.addEventListener('lightsession-config', ((event: CustomEvent<LsConfig>) => {
    const config = event.detail;
    if (config && typeof config === 'object') {
      // Update debug flag first so logging works immediately
      window.__LS_DEBUG__ = config.debug ?? false;

      window.__LS_CONFIG__ = {
        enabled: config.enabled ?? DEFAULT_CONFIG.enabled,
        limit: Math.max(1, config.limit ?? DEFAULT_CONFIG.limit),
        debug: config.debug ?? DEFAULT_CONFIG.debug,
      };
      log('Config updated:', window.__LS_CONFIG__);
    }
  }) as EventListener);
}

// ============================================================================
// Entry Point
// ============================================================================

(function init(): void {
  // Initialize debug flag
  if (typeof window.__LS_DEBUG__ === 'undefined') {
    window.__LS_DEBUG__ = false;
  }

  setupConfigListener();
  patchFetch();

  log('Fetch Proxy loaded');
})();
