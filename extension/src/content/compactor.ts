/**
 * LightSession - Compactor Module
 *
 * Post-trim optimization to simplify kept messages.
 * Dehighlights syntax-highlighted code blocks to reduce DOM complexity.
 *
 * Runs via requestIdleCallback to avoid blocking the main thread.
 * Uses WeakSet to track processed nodes - automatically cleaned up by GC
 * when nodes are removed from DOM.
 */

import { logDebug, logInfo, isDebugMode } from '../shared/logger';

// Track processed nodes to avoid re-processing
// WeakSet automatically removes references when DOM nodes are garbage collected
const processedNodes = new WeakSet<HTMLElement>();

// Mutation suppression - refcount-based with watchdog safety
// Refcount: tracks overlapping runCompactor() calls
// Watchdog: clears stuck suppression if extendSuppression() stops being called
let activeRuns = 0;
let mutationSuppressionUntil = 0;
const MUTATION_SUPPRESSION_SAFETY_MS = 1500; // Safety margin for heavy code blocks
let watchdogTimer: number | undefined;

/**
 * Arm the watchdog timer.
 * If extendSuppression() isn't called within the safety window, watchdog clears suppression.
 * This prevents stuck suppression if compactor crashes/errors without cleanup.
 */
function armWatchdog(): void {
  if (watchdogTimer !== undefined) {
    window.clearTimeout(watchdogTimer);
  }
  watchdogTimer = window.setTimeout(() => {
    if (activeRuns === 0) return; // Already cleaned up
    logDebug(`Compactor: Watchdog cleared stuck suppression (activeRuns was ${activeRuns})`);
    activeRuns = 0;
    mutationSuppressionUntil = 0;
    watchdogTimer = undefined;
  }, MUTATION_SUPPRESSION_SAFETY_MS + 250); // 250ms grace period
}

/**
 * Clear the watchdog timer.
 */
function clearWatchdog(): void {
  if (watchdogTimer !== undefined) {
    window.clearTimeout(watchdogTimer);
    watchdogTimer = undefined;
  }
}

/**
 * Extend the suppression timeout and re-arm watchdog.
 * Called periodically during processing to prevent timeout during heavy work.
 */
function extendSuppression(): void {
  mutationSuppressionUntil = performance.now() + MUTATION_SUPPRESSION_SAFETY_MS;
  armWatchdog();
}

/**
 * Check if mutations should be suppressed (compactor is working).
 * Uses OR logic: suppressed if any run is active OR within safety window.
 * Watchdog handles stuck flags by clearing activeRuns if no ping received.
 * @returns true if mutations should be ignored
 */
export function isMutationSuppressed(): boolean {
  return activeRuns > 0 || performance.now() < mutationSuppressionUntil;
}

/**
 * Start suppressing mutations.
 * Called when compactor begins work. Supports overlapping runs via refcount.
 */
function startMutationSuppression(): void {
  activeRuns++;
  mutationSuppressionUntil = performance.now() + MUTATION_SUPPRESSION_SAFETY_MS;
  armWatchdog();
  logDebug(`Compactor: Mutation suppression started (activeRuns: ${activeRuns})`);
}

/**
 * Stop suppressing mutations.
 * Called when compactor finishes work. Only fully stops when all runs complete.
 */
function stopMutationSuppression(): void {
  activeRuns = Math.max(0, activeRuns - 1);
  if (activeRuns === 0) {
    mutationSuppressionUntil = 0;
    clearWatchdog();
    logDebug('Compactor: Mutation suppression ended (all runs complete)');
  } else {
    logDebug(`Compactor: Run finished, ${activeRuns} still active`);
  }
}

// Selectors for syntax-highlighted code blocks
// These are common patterns used by ChatGPT and highlight.js
// Note: :has() is NOT used - it throws DOMException on older browsers
const CODE_BLOCK_SELECTORS = [
  // Highlight.js patterns
  'pre code[class*="hljs"]',
  'pre code[class*="language-"]',
  'pre[class*="hljs"]',
  // ChatGPT specific patterns
  '.code-block pre',
  '[data-testid*="code-block"] pre',
  'pre.code-block',
  'div[class*="code-block"] pre',
  // Broader patterns for ChatGPT's current structure
  '[class*="overflow-y-auto"] pre',  // Code container with scroll
  '[class*="bg-black"] pre',         // Dark background code blocks
  // Fallback: any pre with code child (will be filtered by span count)
  'pre code',
];

// Minimum number of spans to consider a code block "highlighted"
const MIN_SPANS_FOR_DEHIGHLIGHT = 5;

/**
 * Replace syntax-highlighted code with plain text.
 * Preserves the code content, removes highlighting spans.
 *
 * Expects canonical element (pre) - caller handles normalization.
 *
 * @param preElement The canonical pre element to dehighlight
 * @returns true if dehighlighting was performed, false otherwise
 */
function dehighlightCodeBlock(preElement: HTMLElement): boolean {
  // Skip if already processed (WeakSet tracks across all calls)
  if (processedNodes.has(preElement)) {
    return false;
  }

  // Mark as processed before any work
  processedNodes.add(preElement);

  // Count spans before (for logging and threshold check)
  const spanCount = preElement.querySelectorAll('span').length;

  if (spanCount < MIN_SPANS_FOR_DEHIGHLIGHT) {
    // Not significantly highlighted, skip
    logDebug(`Skipping code block with ${spanCount} spans (threshold: ${MIN_SPANS_FOR_DEHIGHLIGHT})`);
    return false;
  }

  // Find the innermost code element if this is a pre > code structure
  const codeChild = preElement.querySelector('code');
  const targetElement = codeChild ?? preElement;

  // Get plain text from codeChild if available, otherwise from pre
  // This avoids capturing "Copy code" buttons or other UI elements inside pre
  const plainText = codeChild?.textContent ?? preElement.textContent ?? '';

  // Replace innerHTML with plain text
  // This removes all highlighting spans while preserving the text
  targetElement.textContent = plainText;

  // Add a marker class so we know this was dehighlighted
  targetElement.classList.add('ls-dehighlighted');

  logDebug(`Dehighlighted code block: removed ${spanCount} spans`);
  return true;
}

// Pre-joined selector for single querySelectorAll (faster than N separate queries)
const CODE_BLOCK_SELECTOR_JOINED = CODE_BLOCK_SELECTORS.join(',');

/**
 * Process code blocks in the given container.
 * Uses single querySelectorAll with joined selectors for performance.
 * Deduplicates to canonical <pre> elements before processing to avoid
 * function call overhead when selectors match both pre and pre>code.
 *
 * @param container The container element to search within
 * @returns Number of code blocks that were dehighlighted
 */
function processCodeBlocks(container: HTMLElement): number {
  // Single query with all selectors joined - faster than N separate queries
  const matches = container.querySelectorAll<HTMLElement>(CODE_BLOCK_SELECTOR_JOINED);

  // Deduplicate to canonical <pre> elements before processing
  // This avoids function call overhead when selectors match both `pre` and `pre>code`
  const uniquePres = new Set<HTMLElement>();
  for (let i = 0; i < matches.length; i++) {
    const el = matches[i];
    if (!el) continue;
    // Normalize to <pre> if possible, otherwise use the element itself
    const canonical = el.tagName === 'PRE' ? el : (el.closest('pre') as HTMLElement | null);
    uniquePres.add(canonical ?? el);
  }

  // Process unique elements
  let processed = 0;
  for (const block of uniquePres) {
    if (dehighlightCodeBlock(block)) {
      processed++;
    }
  }

  // Debug: log what we found (only if debug mode AND no matches)
  if (matches.length === 0 && isDebugMode()) {
    const anyPre = container.querySelectorAll('pre');
    const anyCode = container.querySelectorAll('code');
    if (anyPre.length > 0 || anyCode.length > 0) {
      logDebug(`Compactor: Found ${anyPre.length} <pre>, ${anyCode.length} <code>, but none matched selectors`);
      if (anyPre.length > 0) {
        const firstPre = anyPre[0];
        logDebug(`Compactor: First <pre> classes: "${firstPre?.className}", parent: "${firstPre?.parentElement?.className}"`);
      }
    }
  }

  return processed;
}

// Number of most recent messages to skip (preserve readability of latest responses)
const SKIP_LAST_N_MESSAGES = 2;

/**
 * Run compactor on kept messages via requestIdleCallback.
 * This is the main entry point called after trim completes.
 *
 * Skips the last N messages to preserve UX - user is likely reading the most recent response.
 *
 * @param keptNodes Array of kept message nodes to process
 */
export function runCompactor(keptNodes: HTMLElement[]): void {
  // Skip last N messages to preserve readability of latest responses
  const processableCount = Math.max(0, keptNodes.length - SKIP_LAST_N_MESSAGES);
  const nodesToProcess = keptNodes.slice(0, processableCount);

  if (nodesToProcess.length === 0) {
    logDebug(`Compactor: No nodes to process (${keptNodes.length} kept, skipping last ${SKIP_LAST_N_MESSAGES})`);
    return;
  }

  logDebug(`Compactor: Starting processing of ${nodesToProcess.length} nodes (skipping last ${SKIP_LAST_N_MESSAGES})`);

  // Track if this is the first chunk (suppression starts on first actual DOM work)
  let isFirstChunk = true;

  const runTask = (deadline: IdleDeadline, nodes: HTMLElement[], startIndex: number): void => {
    // Start suppression on first chunk (when we actually do DOM work, not before)
    if (isFirstChunk) {
      isFirstChunk = false;
      startMutationSuppression();
    } else {
      // Extend safety timeout for subsequent chunks
      extendSuppression();
    }

    let totalProcessed = 0;
    let index = startIndex;
    let scheduledNext = false;

    try {
      // Process nodes while we have idle time (at least 2ms per iteration)
      while (index < nodes.length && deadline.timeRemaining() > 2) {
        // Extend suppression every 4 iterations (not every iteration - cheaper)
        if ((index - startIndex) % 4 === 0) {
          extendSuppression();
        }

        const node = nodes[index];
        if (node && node.isConnected) {
          totalProcessed += processCodeBlocks(node);
        }
        index++;
      }

      if (totalProcessed > 0) {
        logInfo(`Compactor: Dehighlighted ${totalProcessed} code blocks`);
      }

      // Continue if more nodes to process
      if (index < nodes.length) {
        logDebug(`Compactor: ${nodes.length - index} nodes remaining, scheduling next chunk`);
        scheduledNext = true;
        requestIdleCallback(
          (nextDeadline) => runTask(nextDeadline, nodes, index),
          { timeout: 1000 }
        );
      } else {
        logDebug('Compactor: Processing complete');
      }
    } finally {
      // Stop suppression if we're not continuing (done or error)
      if (!scheduledNext) {
        stopMutationSuppression();
      }
    }
  };

  // Start processing with 2 second timeout (will run even if no idle time)
  requestIdleCallback(
    (deadline) => runTask(deadline, nodesToProcess, 0),
    { timeout: 2000 }
  );
}

/**
 * Check if compactor should run based on settings.
 *
 * @param ultraLean Whether ultra lean mode is enabled
 * @returns true if compactor should run
 */
export function shouldRunCompactor(ultraLean: boolean): boolean {
  return ultraLean;
}

/**
 * Reset processed nodes tracking.
 * Call this on navigation to new chat to allow re-processing.
 * Note: WeakSet automatically handles cleanup when nodes are removed,
 * but this is useful for explicit reset scenarios.
 */
export function resetCompactorState(): void {
  // WeakSet doesn't have a clear() method, but since it uses weak references,
  // old entries will be garbage collected when their DOM nodes are removed.
  // For explicit reset, we could create a new WeakSet, but it's not necessary
  // since the old nodes will be GC'd anyway.
  logDebug('Compactor: State reset (WeakSet will auto-clean)');
}
