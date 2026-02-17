/**
 * Trimly - Trimming Logic
 *
 * Core algorithm for trimming ChatGPT conversation data.
 * Extracted for testability and reuse.
 */

// ============================================================================
// Types
// ============================================================================

export interface ChatMessage {
  author?: {
    role?: string;
  };
}

export interface ChatNode {
  parent: string | null;
  children?: string[];
  message?: ChatMessage;
}

export interface ChatMapping {
  [nodeId: string]: ChatNode;
}

export interface ConversationData {
  mapping?: ChatMapping;
  current_node?: string;
  root?: string;
}

export interface TrimResult {
  mapping: ChatMapping;
  current_node: string;
  root: string;
  keptCount: number;
  totalCount: number;
  visibleKept: number;
  visibleTotal: number;
  roundKept: number;
  roundTotal: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Roles that are NOT visible to users (hidden/internal).
 * Everything else (user, assistant, etc.) is considered visible.
 */
export const HIDDEN_ROLES = new Set([
  'system', // System prompts
  'tool', // Tool/function calls
  'thinking', // Extended Thinking internal nodes
]);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a node is a visible message.
 * A node is visible if it has a message with an author role that is NOT in HIDDEN_ROLES.
 * Nodes without messages (like root nodes) are not visible.
 */
export function isVisibleMessage(node: ChatNode): boolean {
  const role = node.message?.author?.role;
  // Must have a role to be considered a message
  if (!role) return false;
  // Exclude hidden/internal roles
  return !HIDDEN_ROLES.has(role);
}

function isUserMessage(node: ChatNode): boolean {
  return (node.message?.author?.role || '').toLowerCase() === 'user';
}

// ============================================================================
// Trimming Algorithm
// ============================================================================

/**
 * Trim conversation mapping to keep only the last N messages in the thread.
 *
 * Algorithm:
 * 1. Start from current_node, walk up via parent links to build the full path
 * 2. Reverse to get chronological order (oldest first)
 * 3. Count USER prompts (conversation rounds)
 * 4. Keep only the last `limit` user prompts and all visible messages after them
 * 5. Rebuild mapping with only kept nodes, fixing parent/children links
 *
 * @param data - The conversation data containing mapping and current_node
 * @param limit - Number of user prompts (rounds) to keep
 * @returns TrimResult with new mapping, or null if trimming not possible
 */
export function trimMapping(
  data: ConversationData,
  limit: number
): TrimResult | null {
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

  // Count total visible messages (for stats)
  let visibleTotal = 0;
  for (const nodeId of path) {
    const node = mapping[nodeId];
    if (node && isVisibleMessage(node)) {
      visibleTotal++;
    }
  }

  // Find cut point by user prompt count:
  // keep last N user messages and everything after the oldest kept user.
  let cutIndex = 0;
  const userIndices: number[] = [];
  const visibleIndices: number[] = [];
  for (let i = 0; i < path.length; i++) {
    const nodeId = path[i];
    if (!nodeId) continue;

    const node = mapping[nodeId];
    if (node && isVisibleMessage(node)) {
      visibleIndices.push(i);
      if (isUserMessage(node)) {
        userIndices.push(i);
      }
    }
  }

  if (userIndices.length > effectiveLimit) {
    const startUserIndex = userIndices[userIndices.length - effectiveLimit];
    cutIndex = startUserIndex ?? 0;
  } else if (userIndices.length === 0 && visibleIndices.length > effectiveLimit) {
    // Fallback for atypical threads with no user nodes.
    const startVisibleIndex = visibleIndices[visibleIndices.length - effectiveLimit];
    cutIndex = startVisibleIndex ?? 0;
  }

  const keptRaw = path.slice(cutIndex);

  // Filter to ONLY user/assistant nodes (remove system/tool that got included)
  const kept = keptRaw.filter((id) => {
    const node = mapping[id];
    return node && isVisibleMessage(node);
  });

  if (kept.length === 0) {
    return null;
  }

  // Preserve original root node - ChatGPT needs this "(no role)" node as tree anchor
  const originalRootId = path[0];
  const originalRootNode = originalRootId ? mapping[originalRootId] : null;
  const hasOriginalRoot = originalRootId && originalRootNode;

  // Build new mapping with kept nodes + original root
  const newMapping: ChatMapping = {};
  // Add original root node first (the "(no role)" anchor node)
  if (hasOriginalRoot) {
    newMapping[originalRootId] = {
      ...originalRootNode,
      parent: null,
      children: kept[0] ? [kept[0]] : [],
    };
  }

  // Add kept visible nodes
  for (let i = 0; i < kept.length; i++) {
    const id = kept[i];
    if (!id) continue;

    // First kept node's parent is originalRoot (if exists), otherwise null
    const prevId =
      i === 0 ? (hasOriginalRoot ? originalRootId : null) : kept[i - 1];
    const nextId = kept[i + 1] ?? null;
    const originalNode = mapping[id];

    if (originalNode) {
      newMapping[id] = {
        ...originalNode,
        parent: prevId ?? null,
        children: nextId ? [nextId] : [],
      };
    }
  }

  const visibleKept = kept.length;
  const roundTotal = userIndices.length > 0 ? userIndices.length : visibleTotal;
  const roundKept =
    userIndices.length > 0
      ? kept.reduce((count, id) => {
          const node = mapping[id];
          return count + (node && isUserMessage(node) ? 1 : 0);
        }, 0)
      : visibleKept;

  // Use original root if available, otherwise first kept node
  const newRoot = hasOriginalRoot ? originalRootId : kept[0];
  const newCurrentNode = kept[kept.length - 1];

  // These should always be defined since kept.length > 0, but TypeScript needs assurance
  if (!newRoot || !newCurrentNode) {
    return null;
  }

  return {
    mapping: newMapping,
    current_node: newCurrentNode,
    root: newRoot,
    keptCount: kept.length,
    totalCount,
    visibleKept,
    visibleTotal,
    roundKept,
    roundTotal,
  };
}
