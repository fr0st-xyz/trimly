/**
 * LightSession for ChatGPT - Trimmer State Machine
 * Core trimming logic with state management and batch execution
 *
 * Two trim modes:
 * - BOOT: First ~1.5s after load/navigation. Uses queueMicrotask for instant
 *   trimming BEFORE browser paints. No debounce, layout-read-free.
 * - STEADY: After stabilization. Uses debounced callbacks + requestIdleCallback
 *   for efficient, non-blocking trimming.
 */

import type { TrimmerState, LsSettings, NodeInfo, EvaluateTrimOptions, TrimMode } from '../shared/types';
import { TIMING, DOM, DEFAULT_SETTINGS } from '../shared/constants';
import { logDebug, logWarn, logInfo, logError } from '../shared/logger';
import { buildActiveThread, buildActiveThreadFast, findConversationRoot, findMessagesRoot, canUseShallowObserver, isNearBottom } from './dom-helpers';
import { isStreaming } from './stream-detector';
import { createAdaptiveObserver } from './observers';
import { updateStatusBar } from './status-bar';
import { runCompactor, shouldRunCompactor } from './compactor';

// Flag to track if first successful trim happened (for early BOOT exit)
let firstTrimCompleted = false;

// Current settings reference for reattachObserver (updated on each trim)
let currentTrimSettings: LsSettings | null = null;
let currentTrimMode: TrimMode = 'BOOT';

// Observer config kind - stored to avoid repeated canUseShallowObserver() calls
// Updated whenever observer is attached (boot, transition, reattach)
type ObserverKind = 'STANDARD' | 'LEAN' | 'SHALLOW';
let currentObserverKind: ObserverKind = 'STANDARD';

/**
 * Initial trimmer state
 */
export function createInitialState(): TrimmerState {
  // Reset per-instance flags when creating new state
  firstTrimCompleted = false;
  currentObserverKind = 'STANDARD';

  return {
    current: 'IDLE',
    observer: null,
    trimScheduled: false,
    lastTrimTime: 0,
    conversationRoot: null,
    settings: { ...DEFAULT_SETTINGS },
    trimMode: 'BOOT',
    bootStartTime: 0,
  };
}

/**
 * Check if BOOT mode should end
 * Ends when: duration elapsed OR first successful trim completed
 */
export function shouldExitBootMode(state: TrimmerState): boolean {
  if (state.trimMode !== 'BOOT') {
    return false;
  }

  // Exit early if first trim completed successfully
  if (firstTrimCompleted) {
    return true;
  }

  // Exit after duration elapsed
  const elapsed = performance.now() - state.bootStartTime;
  return elapsed >= TIMING.BOOT_DURATION_MS;
}

/**
 * Mark first trim as completed (triggers early BOOT exit)
 */
export function markFirstTrimCompleted(): void {
  if (!firstTrimCompleted) {
    firstTrimCompleted = true;
    logInfo('First trim completed, will transition to STEADY mode');
  }
}

/**
 * Transition from BOOT to STEADY mode if conditions met
 * Conditions: duration elapsed OR first successful trim
 *
 * In Ultra Lean mode, uses lean observer config (no attributes)
 */
export function maybeTransitionToSteady(
  state: TrimmerState,
  onMutation: () => void
): TrimmerState {
  if (state.trimMode !== 'BOOT' || !shouldExitBootMode(state)) {
    return state;
  }

  const reason = firstTrimCompleted
    ? 'first trim completed'
    : `${TIMING.BOOT_DURATION_MS}ms elapsed`;
  logInfo(`Transitioning from BOOT to STEADY mode (${reason})`);

  // Disconnect current observer and create a new debounced one
  if (state.observer) {
    state.observer.disconnect();
  }

  // Reset stream cache - BOOT mode cachedLastNode may be stale for STEADY layout
  resetStreamCache();

  // In Ultra Lean mode, FAIL-CLOSED: if messagesRoot not found, don't observe
  // This prevents falling back to wide root that includes composer (causes input lag)
  // The rootSyncWatcher will retry and rebind when layout becomes available
  let root: HTMLElement | null;
  if (state.settings.ultraLean) {
    root = findMessagesRoot();
    if (!root) {
      logWarn('UltraLean: messagesRoot not found in STEADY, pausing observer (will retry)');
      return {
        ...state,
        trimMode: 'STEADY',
        observer: null,
        // Keep conversationRoot for retry reference
      };
    }
  } else {
    root = state.conversationRoot ?? findConversationRoot();
    if (!root) {
      return { ...state, trimMode: 'STEADY' };
    }
  }

  const newObserver = createAdaptiveObserver(onMutation, 'STEADY');
  const config = getObserverConfig('STEADY', state.settings.ultraLean);
  newObserver.observe(root, config);

  logDebug(`STEADY mode observer attached (ultraLean: ${state.settings.ultraLean}, config: ${state.settings.ultraLean ? 'LEAN' : 'STANDARD'})`);

  return {
    ...state,
    trimMode: 'STEADY',
    observer: newObserver,
    conversationRoot: root,
  };
}

/**
 * MutationObserver configuration - standard mode
 * Monitors childList + specific attributes for message changes
 */
const OBSERVER_CONFIG: MutationObserverInit = {
  childList: true,
  subtree: true,
  // Monitor specific attributes that indicate message changes
  // This reduces callback invocations for unrelated DOM changes
  attributes: true,
  attributeFilter: [
    'data-turn',
    'data-message-id',
    'data-message-author-role',
    'hidden',
    'aria-hidden',
  ],
};

/**
 * MutationObserver configuration - Ultra Lean mode (with subtree)
 * Only childList monitoring - no attributes
 * Reduces callback invocations when typing in composer
 */
const OBSERVER_CONFIG_LEAN: MutationObserverInit = {
  childList: true,
  subtree: true,
  // No attributes - reduces noise from composer typing, focus changes, etc.
};

/**
 * MutationObserver configuration - Ultra Lean SHALLOW mode
 * Only direct children, no subtree - maximum performance
 * Used when messages are direct children of the observed root
 */
const OBSERVER_CONFIG_SHALLOW: MutationObserverInit = {
  childList: true,
  subtree: false,
  // No subtree - only catches direct child additions/removals
  // This is the maximum performance config, but only works when
  // message elements are direct children of the observed root
};

// ============================================================================
// Stream Observer (for SHALLOW mode during streaming)
// ============================================================================

/**
 * Stream observer: watches the last message node during streaming.
 *
 * When using SHALLOW observer (subtree: false), we only catch direct child
 * additions/removals. But streaming happens INSIDE the last message node
 * (text additions, markdown chunks). This observer catches those.
 *
 * Key insight: main observer = cheap (shallow), stream observer = deep but
 * only 1 element. Best of both worlds.
 */
let streamObserver: MutationObserver | null = null;
let streamTarget: HTMLElement | null = null;
let streamTickTimer: number | null = null;
const STREAM_THROTTLE_MS = 250;

/**
 * Schedule a throttled stream tick callback.
 * Prevents flood of mutations during token-by-token streaming.
 */
function scheduleStreamTick(onMutation: () => void): void {
  if (streamTickTimer !== null) {
    return; // Already scheduled
  }
  streamTickTimer = window.setTimeout(() => {
    streamTickTimer = null;
    onMutation();
  }, STREAM_THROTTLE_MS);
}

/**
 * Disconnect and cleanup stream observer.
 * Note: Does NOT reset cachedLastNode - that's done separately via resetStreamCache()
 * to allow cache reuse during target switching.
 */
export function detachStreamObserver(): void {
  // Clear throttle timer first
  if (streamTickTimer !== null) {
    clearTimeout(streamTickTimer);
    streamTickTimer = null;
  }

  if (streamObserver) {
    streamObserver.disconnect();
    streamObserver = null;
    streamTarget = null;
    logDebug('Stream observer detached');
  }
}

/**
 * Reset stream observer cache.
 * Call this on shutdown/navigation to prevent stale references.
 * Separate from detachStreamObserver() to allow cache reuse during target switching.
 */
function resetStreamCache(): void {
  cachedLastNode = null;
}

// Store onMutation callback for stream observer (set by evaluateTrim)
let streamOnMutation: (() => void) | null = null;

// Cache last known lastNode for stream observer (updated by evaluateTrim)
// Used when streaming causes early return before node building
let cachedLastNode: HTMLElement | null = null;

/**
 * Set the mutation callback for stream observer.
 * Called from evaluateTrim to avoid passing callbacks through signatures.
 */
export function setStreamObserverCallback(onMutation: () => void): void {
  streamOnMutation = onMutation;
}

/**
 * Ensure stream observer is attached to the last message during streaming.
 * Only active in Ultra Lean + SHALLOW mode + streaming. No-op otherwise.
 *
 * This version receives lastNode directly from evaluateTrim to avoid DOM scan.
 *
 * @param state Current trimmer state
 * @param lastNode Last message node (already found by evaluateTrim)
 */
export function ensureStreamObserverWithTarget(
  state: TrimmerState,
  lastNode: HTMLElement | null
): void {
  // Early exit if trimmer not active
  if (!state.settings.enabled || state.current !== 'OBSERVING') {
    detachStreamObserver();
    return;
  }

  // Only needed in STEADY mode with ultraLean + SHALLOW observer
  // When using SHALLOW (subtree:false), main observer only catches direct children
  // Stream observer watches inside the last message for streaming content
  if (state.trimMode !== 'STEADY' || !state.settings.ultraLean) {
    detachStreamObserver();
    return;
  }

  // Check if we're using shallow observer (use stored kind, no DOM traversal)
  if (currentObserverKind !== 'SHALLOW') {
    // Not using shallow - subtree:true catches everything
    detachStreamObserver();
    return;
  }

  // Check if currently streaming
  // Use wide root for streaming detection - indicators may be outside messagesRoot
  if (!isStreaming(findConversationRoot())) {
    detachStreamObserver();
    return;
  }

  // Use provided lastNode or fall back to cached value
  const targetNode = lastNode ?? cachedLastNode;

  // Need a valid target and callback
  if (!targetNode || !streamOnMutation) {
    detachStreamObserver();
    return;
  }

  // Guard: targetNode must still be connected to DOM (SPA navigation can detach)
  if (!targetNode.isConnected) {
    resetStreamCache();
    detachStreamObserver();
    return;
  }

  // Guard: only attach to assistant messages (streaming happens in assistant turns)
  // User messages don't stream, so watching them is wasteful
  const isAssistant =
    targetNode.dataset.turn === 'assistant' ||
    targetNode.getAttribute('data-message-author-role') === 'assistant';
  if (!isAssistant) {
    detachStreamObserver();
    return;
  }

  // Update cache if new lastNode provided
  if (lastNode) {
    cachedLastNode = lastNode;
  }

  // Already observing this node?
  if (streamTarget === targetNode && streamObserver) {
    return;
  }

  // Switch to new target
  detachStreamObserver();
  streamTarget = targetNode;

  const onMutation = streamOnMutation;
  streamObserver = new MutationObserver(() => {
    // Throttle callbacks to prevent flood during token-by-token streaming
    scheduleStreamTick(onMutation);
  });

  streamObserver.observe(targetNode, {
    childList: true,
    subtree: true,
    characterData: true, // Important for text streaming
  });

  logDebug('Stream observer attached to last message');
}

/**
 * Get appropriate observer config based on mode and settings.
 * Also updates the module-level currentObserverKind for use by other functions.
 *
 * @param trimMode Current trim mode (BOOT or STEADY)
 * @param ultraLean Whether ultra lean mode is enabled
 * @returns Appropriate MutationObserverInit config
 */
export function getObserverConfig(trimMode: TrimMode, ultraLean: boolean): MutationObserverInit {
  // In BOOT mode, always use full config for reliable initial detection
  // We need attributes to catch initial message renders
  if (trimMode === 'BOOT') {
    currentObserverKind = 'STANDARD';
    return OBSERVER_CONFIG;
  }

  // In STEADY mode with ultraLean, try shallow config first
  if (ultraLean) {
    // Check if messages are direct children - if so, use shallow for max performance
    if (canUseShallowObserver()) {
      logDebug('Using SHALLOW observer config (messages are direct children)');
      currentObserverKind = 'SHALLOW';
      return OBSERVER_CONFIG_SHALLOW;
    }
    // Fall back to lean config (subtree: true but no attributes)
    logDebug('Using LEAN observer config (messages are nested)');
    currentObserverKind = 'LEAN';
    return OBSERVER_CONFIG_LEAN;
  }

  currentObserverKind = 'STANDARD';
  return OBSERVER_CONFIG;
}

/**
 * Get appropriate observation root based on settings
 *
 * @param ultraLean Whether ultra lean mode is enabled
 * @returns Narrower messages root when ultraLean, otherwise full conversation root
 */
function getObservationRoot(ultraLean: boolean): HTMLElement | null {
  return ultraLean ? findMessagesRoot() : findConversationRoot();
}

/**
 * Boot trimmer: IDLE → OBSERVING
 * Finds conversation root and attaches MutationObserver
 * Starts in BOOT mode for aggressive pre-paint trimming
 *
 * In Ultra Lean mode, uses narrower messages root (excludes composer)
 */
export function boot(state: TrimmerState, onMutation: () => void): TrimmerState {
  if (state.current !== 'IDLE') {
    logWarn('Cannot boot: Already active');
    return state;
  }

  // Use narrower root in Ultra Lean mode
  const root = getObservationRoot(state.settings.ultraLean);
  if (!root) {
    logWarn('Cannot boot: Conversation root not found');
    return state;
  }

  // Reset per-boot flag to ensure clean BOOT cycle
  firstTrimCompleted = false;

  // Start in BOOT mode for aggressive trimming before first paint
  const trimMode: TrimMode = 'BOOT';
  const bootStartTime = performance.now();

  const observer = createAdaptiveObserver(onMutation, trimMode);
  const config = getObserverConfig(trimMode, state.settings.ultraLean);
  observer.observe(root, config);

  logInfo(`Trimmer booted in ${trimMode} mode (ultraLean: ${state.settings.ultraLean})`);

  return {
    ...state,
    current: 'OBSERVING',
    observer,
    conversationRoot: root,
    trimMode,
    bootStartTime,
  };
}

/**
 * Shutdown trimmer: * → IDLE
 * Disconnects observer and cleans up
 */
export function shutdown(state: TrimmerState): TrimmerState {
  if (state.observer) {
    state.observer.disconnect();
  }

  // Disconnect stream observer and clear cache (navigation/shutdown)
  detachStreamObserver();
  resetStreamCache();

  // Reset observer kind
  currentObserverKind = 'STANDARD';

  logInfo('Trimmer shut down');

  return {
    ...createInitialState(),
    settings: state.settings, // Preserve settings
  };
}

/**
 * Schedule trim evaluation with mode-adaptive scheduling
 *
 * BOOT mode: queueMicrotask for instant execution before paint
 * STEADY mode: setTimeout with debounce for batching
 *
 * @param state Current trimmer state
 * @param evaluateTrimCallback Callback to evaluate and execute trim
 * @param onComplete Optional callback invoked after trim completes (success or error)
 *                   Used to reset trimScheduled flag in caller's state
 */
export function scheduleTrim(
  state: TrimmerState,
  evaluateTrimCallback: () => void,
  onComplete?: () => void
): TrimmerState {
  if (!state.settings.enabled || state.trimScheduled) {
    return state;
  }

  const executeWithErrorHandling = (): void => {
    try {
      evaluateTrimCallback();
    } catch (error) {
      logError('Trim evaluation failed:', error);
    } finally {
      // Always invoke onComplete to allow caller to reset trimScheduled
      // This ensures state doesn't get stuck if callback throws
      onComplete?.();
    }
  };

  if (state.trimMode === 'BOOT') {
    // BOOT mode: immediate execution via microtask
    // This runs BEFORE the browser paints, preventing "flash" of untrimmed content
    queueMicrotask(executeWithErrorHandling);
  } else {
    // STEADY mode: debounced execution for efficiency
    setTimeout(executeWithErrorHandling, TIMING.DEBOUNCE_MS);
  }

  return { ...state, trimScheduled: true };
}

/**
 * Calculate how many nodes to keep
 */
export function calculateKeepCount(settings: LsSettings): number {
  return settings.keep;
}

/**
 * Evaluate trim: Check preconditions and execute if met
 * PENDING_TRIM → TRIMMING or back to OBSERVING
 *
 * @param state Current trimmer state
 * @param options Evaluation options including optional settings snapshot
 *                Using a settings snapshot prevents race conditions when
 *                settings change during async trim scheduling
 */
export function evaluateTrim(state: TrimmerState, options: EvaluateTrimOptions = {}): TrimmerState {
  // Use provided settings snapshot or fall back to current state settings
  // This prevents race conditions when settings change between scheduling and execution
  const settings = options.settings ?? state.settings;

  logDebug('=== evaluateTrim called ===');
  logDebug(`Settings: enabled=${settings.enabled}, keep=${settings.keep}, mode=${state.trimMode}`);

  // Precondition 1: Enabled
  if (!settings.enabled) {
    logDebug('Trim evaluation skipped: Disabled');
    return { ...state, current: 'OBSERVING', trimScheduled: false };
  }

  // Precondition 2: Not streaming (skip in BOOT mode for speed)
  // Always use wide root for streaming detection - indicators may be outside messagesRoot
  const wideRoot = findConversationRoot();
  if (state.trimMode !== 'BOOT' && isStreaming(wideRoot)) {
    logDebug('Trim evaluation skipped: Streaming in progress');
    // Still ensure stream observer is attached during streaming (uses cached lastNode)
    ensureStreamObserverWithTarget(state, null);
    return { ...state, current: 'OBSERVING', trimScheduled: false };
  }

  // Build active thread using mode-appropriate strategy
  // BOOT: layout-read-free for pre-paint trimming
  // STEADY: full validation for accuracy
  // UltraLean: scope queries to messagesRoot for faster DOM traversal
  logDebug(`Building active thread [${state.trimMode}]...`);

  // In ultraLean STEADY mode, FAIL-CLOSED: if messagesRoot not found, skip evaluation
  // This prevents scanning the whole document which defeats ultraLean purpose
  let queryRoot: HTMLElement | undefined;
  if (settings.ultraLean && state.trimMode === 'STEADY') {
    const messagesRoot = findMessagesRoot();
    if (!messagesRoot) {
      logDebug('Trim evaluation skipped: UltraLean STEADY but messagesRoot not found');
      return { ...state, current: 'OBSERVING', trimScheduled: false };
    }
    queryRoot = messagesRoot;
  } else if (settings.ultraLean) {
    // BOOT mode: try messagesRoot but allow fallback for initial detection
    queryRoot = findMessagesRoot() ?? undefined;
  }

  // Choose build strategy:
  // - BOOT mode: always fast (pre-paint speed critical)
  // - UltraLean: always fast (eliminates ALL layout reads)
  // - STEADY near bottom: fast path (avoids layout reads during active chat)
  // - STEADY scrolled up: full validation (user reading history, precision matters)
  const useFastPath = state.trimMode === 'BOOT' || settings.ultraLean || isNearBottom(queryRoot);
  const nodes = useFastPath ? buildActiveThreadFast(queryRoot) : buildActiveThread(queryRoot);
  logDebug(`Built thread with ${nodes.length} nodes${queryRoot ? ' [scoped]' : ''}${useFastPath ? ' [fast]' : ''}`);

  // Update stream observer with lastNode (for SHALLOW mode during streaming)
  // This is O(1) - we already have the nodes, just pick the last one
  const lastNodeInfo = nodes.length > 0 ? nodes[nodes.length - 1] : null;
  const lastNode = lastNodeInfo?.node ?? null;
  ensureStreamObserverWithTarget(state, lastNode);

  // Precondition 4: Minimum candidate threshold
  if (nodes.length < DOM.MIN_CANDIDATES) {
    logDebug(
      `Trim evaluation skipped: Not enough candidates (${nodes.length} < ${DOM.MIN_CANDIDATES})`
    );
    // Update status bar to show waiting state
    if (settings.showStatusBar) {
      updateStatusBar({
        totalMessages: nodes.length,
        visibleMessages: nodes.length,
        trimmedMessages: 0,
        keepLastN: settings.keep,
      });
    }
    return { ...state, current: 'OBSERVING', trimScheduled: false };
  }

  // Calculate overflow
  const toKeep = calculateKeepCount(settings);
  const overflow = nodes.length - toKeep;

  if (overflow <= 0) {
    logDebug(`Trim evaluation skipped: No overflow (${nodes.length} <= ${toKeep})`);
    // Update status bar with current state (nothing trimmed)
    if (settings.showStatusBar) {
      updateStatusBar({
        totalMessages: nodes.length,
        visibleMessages: nodes.length,
        trimmedMessages: 0,
        keepLastN: settings.keep,
      });
    }
    return { ...state, current: 'OBSERVING', trimScheduled: false };
  }

  // Determine which nodes to remove (oldest first) and which to keep
  const toRemove = nodes.slice(0, overflow);
  const keptNodes = nodes.slice(overflow).map(info => info.node);

  // Execute trim with mode-specific strategy
  logInfo(`Executing trim [${state.trimMode}]: Removing ${toRemove.length} nodes (keeping ${toKeep})`);
  executeTrim(toRemove, state.observer, state.trimMode, settings, keptNodes);

  // Mark first trim as completed (triggers early BOOT→STEADY transition)
  if (state.trimMode === 'BOOT') {
    markFirstTrimCompleted();
  }

  // Update status bar with trimming stats
  if (settings.showStatusBar) {
    const visibleAfterTrim = nodes.length - toRemove.length;
    updateStatusBar({
      totalMessages: nodes.length,
      visibleMessages: visibleAfterTrim,
      trimmedMessages: toRemove.length,
      keepLastN: settings.keep,
    });
  }

  return {
    ...state,
    current: 'OBSERVING',
    trimScheduled: false,
    lastTrimTime: performance.now(),
  };
}

// Callback invoked when trim completes to handle potential missed mutations
let onTrimCompleteCallback: (() => void) | null = null;

// ============================================================================
// Trim Suppressor (prevents echo cycles)
// ============================================================================

/**
 * Flag to suppress mutations during trim execution.
 * Prevents "echo" cycles where:
 * 1. executeTrim removes nodes
 * 2. onTrimCompleteCallback fires handleMutation()
 * 3. handleMutation schedules another trim evaluation
 * 4. Nothing to trim → wasted cycles
 *
 * The flag is set before trim starts and cleared after callback completes.
 * External code should use isTrimSuppressed() and latch mutations for later flush.
 */
let trimSuppressed = false;

/**
 * Check if mutations should be suppressed due to ongoing trim.
 * Called from content.ts handleMutation to skip/latch mutations.
 */
export function isTrimSuppressed(): boolean {
  return trimSuppressed;
}

/**
 * Clear trim suppression flag.
 * Called after trim callback completes to allow normal mutation handling.
 */
function clearTrimSuppression(): void {
  trimSuppressed = false;
}

/**
 * Set a callback to be invoked when trim completes.
 * Used to re-evaluate DOM after observer reconnection in case mutations
 * occurred while observer was disconnected.
 */
export function setOnTrimComplete(callback: (() => void) | null): void {
  onTrimCompleteCallback = callback;
}

/**
 * Execute trim with mode-specific strategy
 *
 * BOOT mode: Synchronous removal for instant effect before paint
 * STEADY mode: Batched chunks via requestIdleCallback for smooth UX
 *
 * Replaces removed nodes with Comment markers
 *
 * @param toRemove Nodes to remove
 * @param observer MutationObserver to disconnect/reconnect
 * @param mode Trim mode (BOOT or STEADY)
 * @param settings Current settings
 * @param keptNodes Nodes that will remain after trim (for compactor, avoids re-scan)
 */
function executeTrim(
  toRemove: NodeInfo[],
  observer: MutationObserver | null,
  mode: TrimMode,
  settings: LsSettings,
  keptNodes: HTMLElement[]
): void {
  // Store settings and mode for reattachObserver
  currentTrimSettings = settings;
  currentTrimMode = mode;

  // Set suppression flag to prevent echo cycles
  // Cleared after callback completes in executeTrimSync/executeTrimBatched
  trimSuppressed = true;

  // Disconnect observer during trim to avoid re-triggering
  if (observer) {
    observer.disconnect();
  }

  const startTime = performance.now();

  if (mode === 'BOOT') {
    // BOOT mode: synchronous removal for instant effect before paint
    // This is critical for preventing "flash" of untrimmed content
    executeTrimSync(toRemove, observer, startTime);
  } else {
    // STEADY mode: batched removal for smooth UX
    executeTrimBatched(toRemove, observer, startTime, keptNodes);
  }
}

/**
 * Synchronous trim execution for BOOT mode
 * Removes all nodes immediately to prevent paint of untrimmed content
 */
function executeTrimSync(
  toRemove: NodeInfo[],
  observer: MutationObserver | null,
  startTime: number
): void {
  let removed = 0;

  for (const nodeInfo of toRemove) {
    try {
      const parent = nodeInfo.node.parentNode;
      if (parent) {
        // Replace with comment marker
        const marker = document.createComment(
          `${DOM.REMOVAL_MARKER}-${nodeInfo.id}-${nodeInfo.role}`
        );
        parent.replaceChild(marker, nodeInfo.node);
        removed++;
      }
    } catch (error) {
      logWarn('Failed to remove node:', error);
    }
  }

  const totalTime = performance.now() - startTime;
  logInfo(`Trim complete [BOOT sync]: Removed ${removed} nodes in ${totalTime.toFixed(2)}ms`);

  // Re-attach observer
  reattachObserver(observer);

  // Invoke callback to handle potential missed mutations
  // Clear suppression AFTER callback completes to prevent echo
  // Use try/finally to ensure suppression is cleared even if callback throws
  if (onTrimCompleteCallback) {
    const callback = onTrimCompleteCallback;
    queueMicrotask(() => {
      try {
        callback();
      } finally {
        clearTrimSuppression();
      }
    });
  } else {
    clearTrimSuppression();
  }
}

/**
 * Batched trim execution for STEADY mode
 * Uses requestIdleCallback to avoid jank
 *
 * @param toRemove Nodes to remove
 * @param observer MutationObserver to reconnect after completion
 * @param startTime Start time for performance logging
 * @param keptNodes Pre-calculated kept nodes for compactor (avoids re-scan)
 */
function executeTrimBatched(
  toRemove: NodeInfo[],
  observer: MutationObserver | null,
  startTime: number,
  keptNodes: HTMLElement[]
): void {
  let removed = 0;

  // Process in chunks
  function processChunk(nodes: NodeInfo[]): void {
    const chunkStartTime = performance.now();
    let processed = 0;

    while (processed < TIMING.NODES_PER_BATCH && nodes.length > 0) {
      const nodeInfo = nodes.shift();
      if (!nodeInfo) break;

      try {
        const parent = nodeInfo.node.parentNode;
        if (parent) {
          // Replace with comment marker
          const marker = document.createComment(
            `${DOM.REMOVAL_MARKER}-${nodeInfo.id}-${nodeInfo.role}`
          );
          parent.replaceChild(marker, nodeInfo.node);
          removed++;
        }
      } catch (error) {
        logWarn('Failed to remove node:', error);
      }

      processed++;

      // Budget check
      const elapsed = performance.now() - chunkStartTime;
      if (elapsed > TIMING.BATCH_BUDGET_MS) {
        break;
      }
    }

    // Schedule next chunk if needed
    if (nodes.length > 0) {
      requestIdleCallback(() => processChunk(nodes), { timeout: 1000 });
    } else {
      // Trim complete
      const totalTime = performance.now() - startTime;
      logInfo(`Trim complete [STEADY batched]: Removed ${removed} nodes in ${totalTime.toFixed(2)}ms`);

      // Re-attach observer
      reattachObserver(observer);

      // Run compactor on kept messages if ultra lean mode is enabled
      // Uses pre-calculated keptNodes to avoid re-scanning DOM
      if (shouldRunCompactor(currentTrimSettings?.ultraLean ?? false)) {
        runCompactor(keptNodes);
      }

      // Invoke callback to handle potential missed mutations
      // Clear suppression AFTER callback completes to prevent echo
      // Use try/finally to ensure suppression is cleared even if callback throws
      if (onTrimCompleteCallback) {
        const callback = onTrimCompleteCallback;
        // Use setTimeout to allow observer to settle before re-evaluation
        setTimeout(() => {
          try {
            callback();
          } finally {
            clearTrimSuppression();
          }
        }, 0);
      } else {
        clearTrimSuppression();
      }
    }
  }

  // Start processing
  requestIdleCallback(() => processChunk([...toRemove]), { timeout: 1000 });
}

/**
 * Re-attach MutationObserver after trim completes
 * Uses stored settings to determine root and config
 */
function reattachObserver(observer: MutationObserver | null): void {
  if (!observer) {
    return;
  }

  const ultraLean = currentTrimSettings?.ultraLean ?? false;
  const root = getObservationRoot(ultraLean);

  if (root) {
    const config = getObserverConfig(currentTrimMode, ultraLean);
    observer.observe(root, config);
  }
}
