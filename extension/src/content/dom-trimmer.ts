/**
 * Trimly- DOM trim fallback
 *
 * Keeps only the last N visible turns in the rendered DOM so settings
 * can apply instantly without reloading the page.
 */

import { logDebug } from '../shared/logger';

const HIDDEN_ATTR = 'data-ls-dom-trimmed';
const HIDDEN_ACTION_ATTR = 'data-ls-dom-trimmed-action';
const SHELL_COLLAPSE_ATTR = 'data-ls-dom-shell-collapsed';
const DOM_STABLE_MIN_KEEP = 2;
const HIDDEN_ROLES = new Set(['system', 'tool', 'thinking']);
const TURN_CONTAINER_SELECTOR =
  '[data-testid^="conversation-turn"], article[data-turn]';
const ACTION_KEYWORDS = [
  'copy',
  'good response',
  'bad response',
  'share',
  'more actions',
  'edit message',
  'try again',
  'retry',
  'regenerate',
  'again',
  'switch model',
];
const BOTTOM_STICK_THRESHOLD_PX = 140;

interface DomTrimmerConfig {
  enabled: boolean;
  keep: number;
}

export interface DomTrimStatus {
  totalRounds: number;
  visibleRounds: number;
  trimmedRounds: number;
  keep: number;
}

export interface DomTrimmerController {
  setConfig: (config: DomTrimmerConfig) => void;
  runNow: () => void;
  teardown: () => void;
}

export function unhideAllTrimlyArtifacts(root: ParentNode = document): void {
  unhideAll(root);
}

function getRoleFromTurn(turn: HTMLElement): string | null {
  const ownRole = turn.getAttribute('data-message-author-role');
  if (ownRole) {
    return ownRole;
  }

  const nestedRole = turn.querySelector<HTMLElement>('[data-message-author-role]');
  return nestedRole?.getAttribute('data-message-author-role') ?? null;
}

function getConversationTurns(root: ParentNode): HTMLElement[] {
  const explicitTurns = Array.from(root.querySelectorAll<HTMLElement>(TURN_CONTAINER_SELECTOR));
  if (explicitTurns.length > 0) {
    return normalizeTurnSet(explicitTurns);
  }

  // Fallback when explicit turn containers are not available in a given UI revision:
  // map message nodes to a likely outer wrapper, but never trim raw leaf nodes.
  const byMessageId = Array.from(root.querySelectorAll<HTMLElement>('[data-message-id]'));
  const mapped: HTMLElement[] = [];
  for (const el of byMessageId) {
    const container = resolveTurnContainer(el);
    if (container) {
      mapped.push(container);
    }
  }
  return normalizeTurnSet(mapped);
}

function resolveTurnContainer(el: HTMLElement): HTMLElement | null {
  const explicit = el.closest<HTMLElement>(TURN_CONTAINER_SELECTOR);
  if (explicit) {
    return explicit;
  }

  const article = el.closest<HTMLElement>('article');
  if (article && article.querySelector('[data-message-id]')) {
    return article;
  }

  return null;
}

function normalizeTurnSet(turns: HTMLElement[]): HTMLElement[] {
  if (turns.length === 0) {
    return [];
  }

  // Keep deterministic DOM order, dedupe, and drop nested children so we only trim
  // top-level turn wrappers (prevents hidden inner nodes from leaving spacer shells).
  const unique = Array.from(new Set(turns));
  const result: HTMLElement[] = [];
  for (const turn of unique) {
    if (result.some((kept) => kept.contains(turn))) {
      continue;
    }

    for (let i = result.length - 1; i >= 0; i--) {
      const kept = result[i];
      if (!kept) {
        continue;
      }
      if (turn.contains(kept)) {
        result.splice(i, 1);
      }
    }
    result.push(turn);
  }
  return result;
}

function isRealMessageTurn(turn: HTMLElement): boolean {
  if (turn.hasAttribute('data-message-id') || turn.querySelector('[data-message-id]')) {
    return true;
  }
  return getRoleFromTurn(turn) !== null;
}

function resolveLayoutTurnElement(turn: HTMLElement): HTMLElement {
  const article = turn.closest<HTMLElement>('article[data-turn]');
  if (article) {
    return article;
  }

  const explicit = turn.closest<HTMLElement>(TURN_CONTAINER_SELECTOR);
  return explicit ?? turn;
}

function hideTurnSpacerSibling(turn: HTMLElement): void {
  const sibling = turn.nextElementSibling;
  if (!(sibling instanceof HTMLElement)) {
    return;
  }
  if (!sibling.classList.contains('sr-only')) {
    return;
  }
  sibling.setAttribute(HIDDEN_ATTR, '1');
  sibling.style.setProperty('display', 'none', 'important');
  sibling.style.setProperty('height', '0', 'important');
  sibling.style.setProperty('min-height', '0', 'important');
  sibling.style.setProperty('max-height', '0', 'important');
  sibling.style.setProperty('margin', '0', 'important');
  sibling.style.setProperty('padding', '0', 'important');
  sibling.style.setProperty('overflow', 'hidden', 'important');
}

function unhideTurnSpacerSibling(turn: HTMLElement): void {
  const sibling = turn.nextElementSibling;
  if (!(sibling instanceof HTMLElement)) {
    return;
  }
  if (!sibling.classList.contains('sr-only') || !sibling.hasAttribute(HIDDEN_ATTR)) {
    return;
  }
  sibling.removeAttribute(HIDDEN_ATTR);
  sibling.style.removeProperty('display');
  sibling.style.removeProperty('height');
  sibling.style.removeProperty('min-height');
  sibling.style.removeProperty('max-height');
  sibling.style.removeProperty('margin');
  sibling.style.removeProperty('padding');
  sibling.style.removeProperty('overflow');
}

function unhideTurn(turn: HTMLElement): boolean {
  const target = resolveLayoutTurnElement(turn);
  if (!target.hasAttribute(HIDDEN_ATTR)) {
    unhideTurnSpacerSibling(target);
    return false;
  }
  target.removeAttribute(HIDDEN_ATTR);
  target.style.removeProperty('display');
  target.style.removeProperty('height');
  target.style.removeProperty('min-height');
  target.style.removeProperty('max-height');
  target.style.removeProperty('margin');
  target.style.removeProperty('padding');
  target.style.removeProperty('overflow');
  target.style.removeProperty('pointer-events');
  unhideTurnSpacerSibling(target);
  return true;
}

function hideTurn(turn: HTMLElement): boolean {
  const target = resolveLayoutTurnElement(turn);
  if (target.hasAttribute(HIDDEN_ATTR)) {
    return false;
  }
  target.setAttribute(HIDDEN_ATTR, '1');
  // Force full layout collapse so hidden turns never reserve scroll space.
  target.style.setProperty('display', 'none', 'important');
  target.style.setProperty('height', '0', 'important');
  target.style.setProperty('min-height', '0', 'important');
  target.style.setProperty('max-height', '0', 'important');
  target.style.setProperty('margin', '0', 'important');
  target.style.setProperty('padding', '0', 'important');
  target.style.setProperty('overflow', 'hidden', 'important');
  target.style.setProperty('pointer-events', 'none', 'important');
  hideTurnSpacerSibling(target);
  return true;
}

function unhideAll(root: ParentNode): void {
  const trimmed = root.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`);
  for (const turn of Array.from(trimmed)) {
    unhideTurn(turn);
  }

  const collapsedShells = root.querySelectorAll<HTMLElement>(`[${SHELL_COLLAPSE_ATTR}]`);
  for (const shell of Array.from(collapsedShells)) {
    uncollapseShell(shell);
  }

  const trimmedActions = root.querySelectorAll<HTMLElement>(`[${HIDDEN_ACTION_ATTR}]`);
  for (const action of Array.from(trimmedActions)) {
    action.removeAttribute(HIDDEN_ACTION_ATTR);
    action.style.removeProperty('display');
  }
}

function isActionControl(el: HTMLElement): boolean {
  const testId = (el.getAttribute('data-testid') || '').toLowerCase();
  const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
  const text = (el.textContent || '').trim().toLowerCase();
  const haystack = `${testId} ${ariaLabel} ${text}`;
  return isSwitchModelControl(el) || ACTION_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function isRetryLikeControl(el: HTMLElement): boolean {
  const testId = (el.getAttribute('data-testid') || '').toLowerCase();
  const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
  const text = (el.textContent || '').trim().toLowerCase();
  const haystack = `${testId} ${ariaLabel} ${text}`;
  return (
    haystack.includes('try again') ||
    haystack.includes('retry') ||
    haystack.includes('regenerate') ||
    haystack.includes('again')
  );
}

function isSwitchModelControl(el: HTMLElement): boolean {
  const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
  return ariaLabel === 'switch model' || ariaLabel.includes('switch model');
}

function isRetryLikeText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === 'try again' ||
    normalized === 'retry' ||
    normalized === 'regenerate'
  );
}

function belongsToVisibleTurn(el: HTMLElement, visibleTurns: Set<HTMLElement>): boolean {
  for (const turn of visibleTurns) {
    if (turn.contains(el)) {
      return true;
    }
  }
  return false;
}

function getMessageIdForElement(el: HTMLElement): string | null {
  const own = el.getAttribute('data-message-id');
  if (own) {
    return own;
  }
  const closest = el.closest('[data-message-id]');
  return closest?.getAttribute('data-message-id') ?? null;
}

function collectVisibleMessageIds(visibleTurns: Set<HTMLElement>): Set<string> {
  const ids = new Set<string>();
  for (const turn of visibleTurns) {
    const own = turn.getAttribute('data-message-id');
    if (own) {
      ids.add(own);
    }
    const nested = turn.querySelectorAll<HTMLElement>('[data-message-id]');
    for (const el of Array.from(nested)) {
      const id = el.getAttribute('data-message-id');
      if (id) {
        ids.add(id);
      }
    }
  }
  return ids;
}

function getFirstVisibleTurnTop(visibleTurns: Set<HTMLElement>): number {
  let minTop = Number.POSITIVE_INFINITY;
  for (const turn of visibleTurns) {
    const rect = turn.getBoundingClientRect();
    if (rect.height > 0 && rect.top < minTop) {
      minTop = rect.top;
    }
  }
  return minTop;
}

function cleanupOrphanActionControls(root: ParentNode, visibleTurns: Set<HTMLElement>): void {
  const visibleMessageIds = collectVisibleMessageIds(visibleTurns);
  const firstVisibleTop = getFirstVisibleTurnTop(visibleTurns);
  const controls = root.querySelectorAll<HTMLElement>(
    'button, [role="button"], [role="menuitem"], [data-testid], [aria-label]'
  );

  for (const control of Array.from(controls)) {
    if (!isActionControl(control)) {
      continue;
    }

    const inVisibleTurn = belongsToVisibleTurn(control, visibleTurns);
    const messageId = getMessageIdForElement(control);
    const belongsToVisibleMessage = !!messageId && visibleMessageIds.has(messageId);

    // Keep controls if they belong to a currently visible message.
    if (inVisibleTurn || belongsToVisibleMessage) {
      if (control.hasAttribute(HIDDEN_ACTION_ATTR)) {
        control.removeAttribute(HIDDEN_ACTION_ATTR);
        control.style.removeProperty('display');
      }
      continue;
    }

    // "Switch model" can leak as a detached Radix trigger from trimmed history.
    // Keep it when it appears at/after the first visible kept turn (current message area),
    // hide it when it's above (trimmed history area).
    if (isSwitchModelControl(control)) {
      if (Number.isFinite(firstVisibleTop)) {
        const rect = control.getBoundingClientRect();
        if (rect.top >= firstVisibleTop - 4) {
          if (control.hasAttribute(HIDDEN_ACTION_ATTR)) {
            control.removeAttribute(HIDDEN_ACTION_ATTR);
            control.style.removeProperty('display');
          }
          continue;
        }
      }
      control.setAttribute(HIDDEN_ACTION_ATTR, '1');
      control.style.display = 'none';
      continue;
    }

    // Hard rule for "Try again"/retry controls: if not tied to a visible message,
    // always hide (these commonly leak as detached portal controls for trimmed turns).
    if (isRetryLikeControl(control)) {
      control.setAttribute(HIDDEN_ACTION_ATTR, '1');
      control.style.display = 'none';
      continue;
    }

    // Detached controls with no message-id can linger after trim.
    // Hide them if they appear above the first visible kept turn.
    if (Number.isFinite(firstVisibleTop)) {
      const rect = control.getBoundingClientRect();
      if (rect.top >= firstVisibleTop - 4) {
        if (control.hasAttribute(HIDDEN_ACTION_ATTR)) {
          control.removeAttribute(HIDDEN_ACTION_ATTR);
          control.style.removeProperty('display');
        }
        continue;
      }
    }

    control.setAttribute(HIDDEN_ACTION_ATTR, '1');
    control.style.display = 'none';
  }

  // Extra safety: some ChatGPT builds render retry controls as wrapper elements
  // (menu/portal structures) where the actionable text is in nested spans/divs.
  // Detect those by text and hide the closest clickable container.
  const retryTextEls = root.querySelectorAll<HTMLElement>('span, div, p, [role="menuitem"]');
  for (const el of Array.from(retryTextEls)) {
    if (!isRetryLikeText(el.textContent || '')) {
      continue;
    }

    const closest = el.closest('button, [role="button"], [role="menuitem"], [data-testid]');
    const target = closest instanceof HTMLElement ? closest : el;
    const inVisibleTurn = belongsToVisibleTurn(target, visibleTurns);
    const messageId = getMessageIdForElement(target);
    const belongsToVisibleMessage = !!messageId && visibleMessageIds.has(messageId);

    if (inVisibleTurn || belongsToVisibleMessage) {
      if (target.hasAttribute(HIDDEN_ACTION_ATTR)) {
        target.removeAttribute(HIDDEN_ACTION_ATTR);
        target.style.removeProperty('display');
      }
      continue;
    }

    target.setAttribute(HIDDEN_ACTION_ATTR, '1');
    target.style.display = 'none';
  }
}

interface ApplyTrimResult {
  changed: boolean;
  totalRounds: number;
  visibleRounds: number;
}

function collapseShell(node: HTMLElement): boolean {
  if (node.hasAttribute(SHELL_COLLAPSE_ATTR)) {
    return false;
  }
  node.setAttribute(SHELL_COLLAPSE_ATTR, '1');
  node.style.setProperty('display', 'none', 'important');
  node.style.setProperty('height', '0', 'important');
  node.style.setProperty('min-height', '0', 'important');
  node.style.setProperty('max-height', '0', 'important');
  node.style.setProperty('margin', '0', 'important');
  node.style.setProperty('padding', '0', 'important');
  node.style.setProperty('overflow', 'hidden', 'important');
  node.style.setProperty('pointer-events', 'none', 'important');
  return true;
}

function uncollapseShell(node: HTMLElement): boolean {
  if (!node.hasAttribute(SHELL_COLLAPSE_ATTR)) {
    return false;
  }
  node.removeAttribute(SHELL_COLLAPSE_ATTR);
  node.style.removeProperty('display');
  node.style.removeProperty('height');
  node.style.removeProperty('min-height');
  node.style.removeProperty('max-height');
  node.style.removeProperty('margin');
  node.style.removeProperty('padding');
  node.style.removeProperty('overflow');
  node.style.removeProperty('pointer-events');
  return true;
}

function sweepPhantomTurnShells(root: ParentNode): boolean {
  let changed = false;
  const shells = root.querySelectorAll<HTMLElement>('article[data-turn], [data-testid^="conversation-turn"]');
  for (const shell of Array.from(shells)) {
    const hasAnyMessage = !!shell.querySelector('[data-message-id]');
    const hasVisibleMessage = !!shell.querySelector(
      `[data-message-id]:not([${HIDDEN_ATTR}]):not([${SHELL_COLLAPSE_ATTR}])`
    );
    const hasWritingBlock = !!shell.querySelector('[data-writing-block]');
    const hasTrimmedMessage = !!shell.querySelector(`[data-message-id][${HIDDEN_ATTR}], [data-message-id][${SHELL_COLLAPSE_ATTR}]`);
    const hasGeneratedImageContent = !!shell.querySelector(
      '.group\\/imagegen-image, [aria-label="Generated image"], img[alt="Generated image"], [id^="image-"]'
    );
    const hasMediaContent = !!shell.querySelector('img, video, canvas, figure, picture');

    // Keep actively writing/streaming shells.
    if (hasWritingBlock) {
      changed = uncollapseShell(shell) || changed;
      continue;
    }
    // Keep active media/image-generation shells even when message-id wrappers
    // are transient or missing (ChatGPT image turns can briefly render this way).
    if (hasGeneratedImageContent || hasMediaContent) {
      changed = uncollapseShell(shell) || changed;
      continue;
    }

    // Collapse any shell that has message content but no visible message node.
    // This handles stale wrappers left after aggressive keep changes (e.g. 27 -> 1),
    // including wrappers whose trim markers were partially reset.
    if (hasAnyMessage && !hasVisibleMessage) {
      changed = collapseShell(shell) || changed;
      continue;
    }

    // Extra guard: if shell itself is marked hidden, ensure layout is collapsed.
    if (shell.hasAttribute(HIDDEN_ATTR) || hasTrimmedMessage) {
      if (!hasVisibleMessage) {
        changed = collapseShell(shell) || changed;
        continue;
      }
    }

    // Last-resort artifact cleanup: only collapse shells that are already marked
    // as trimmed/collapsed artifacts. Do not collapse generic shells just because
    // they have height; that can hide active assistant image turns.
    if (!hasVisibleMessage && (shell.hasAttribute(HIDDEN_ATTR) || shell.hasAttribute(SHELL_COLLAPSE_ATTR))) {
      changed = collapseShell(shell) || changed;
      continue;
    }

    changed = uncollapseShell(shell) || changed;
  }
  return changed;
}

function applyTrim(root: ParentNode, keep: number): ApplyTrimResult {
  const turns = getConversationTurns(root).filter(isRealMessageTurn);
  if (turns.length === 0) {
    return { changed: false, totalRounds: 0, visibleRounds: 0 };
  }
  let changed = false;

  const visibleTurns: Array<{ element: HTMLElement; role: string }> = [];
  for (const turn of turns) {
    const role = getRoleFromTurn(turn);
    if (!role || HIDDEN_ROLES.has(role)) {
      continue;
    }
    visibleTurns.push({ element: turn, role });
  }
  const visibleTurnElements = new Set<HTMLElement>(visibleTurns.map((entry) => entry.element));
  const userPositions: number[] = [];
  for (let i = 0; i < visibleTurns.length; i++) {
    const entry = visibleTurns[i];
    if (entry && entry.role.toLowerCase() === 'user') {
      userPositions.push(i);
    }
  }

  const totalRounds = userPositions.length > 0 ? userPositions.length : visibleTurns.length;

  if (userPositions.length <= keep) {
    const allVisibleTurns = new Set<HTMLElement>(visibleTurns.map((entry) => entry.element));
    for (const turn of turns) {
      changed = unhideTurn(turn) || changed;
    }
    cleanupOrphanActionControls(document, allVisibleTurns);
    changed = sweepPhantomTurnShells(root) || changed;
    return { changed, totalRounds, visibleRounds: totalRounds };
  }

  let startPos = userPositions[userPositions.length - keep] ?? 0;

  // keep=1 can become unstable while a brand-new user message is waiting for
  // its assistant reply (latest visible turn is user). In that transient state,
  // keep one extra round window to avoid aggressive shell churn that can leave
  // phantom scroll space below the composer.
  if (keep === 1 && userPositions.length > 1) {
    const lastVisible = visibleTurns[visibleTurns.length - 1];
    const lastRole = lastVisible?.role.toLowerCase();
    if (lastRole === 'user') {
      const previousUserPos = userPositions[userPositions.length - 2];
      if (typeof previousUserPos === 'number') {
        startPos = previousUserPos;
      }
    }
  }

  const keepElements = new Set<HTMLElement>(visibleTurns.slice(startPos).map((entry) => entry.element));

  for (const turn of turns) {
    // Never hide transient/non-visible wrappers (e.g. freshly sent/in-flight nodes
    // that may not have stable role attributes yet). This prevents newest message
    // from disappearing before the next real turn arrives.
    if (!visibleTurnElements.has(turn)) {
      changed = unhideTurn(turn) || changed;
      continue;
    }

    if (keepElements.has(turn)) {
      changed = unhideTurn(turn) || changed;
    } else {
      changed = hideTurn(turn) || changed;
    }
  }

  cleanupOrphanActionControls(document, keepElements);
  changed = sweepPhantomTurnShells(root) || changed;
  return { changed, totalRounds, visibleRounds: Math.min(totalRounds, keep) };
}

function countUserRoundsInDom(root: ParentNode): number {
  const nodes = root.querySelectorAll<HTMLElement>('[data-message-id][data-message-author-role="user"]');
  return nodes.length;
}

function shouldUseKeepOneStabilityGuard(root: ParentNode): boolean {
  if (root.querySelector('[data-writing-block]')) {
    return true;
  }

  const turns = getConversationTurns(root);
  const visibleTurns: Array<{ element: HTMLElement; role: string }> = [];
  for (const turn of turns) {
    const role = getRoleFromTurn(turn);
    if (!role || HIDDEN_ROLES.has(role)) {
      continue;
    }
    visibleTurns.push({ element: turn, role });
  }

  const last = visibleTurns[visibleTurns.length - 1];
  return last?.role.toLowerCase() === 'user';
}

export function installDomTrimmer(
  onStatusUpdate?: (status: DomTrimStatus) => void
): DomTrimmerController {
  let config: DomTrimmerConfig = { enabled: true, keep: 10 };
  let observer: MutationObserver | null = null;
  let observerRoot: HTMLElement | null = null;
  let scheduled = false;
  let isApplying = false;
  let hardResetPending = false;
  let scrollContainer: HTMLElement | null = null;
  let scrollIdleTimer: number | null = null;
  let scrollActive = false;

  const onScroll = (): void => {
    scrollActive = true;
    if (scrollIdleTimer !== null) {
      window.clearTimeout(scrollIdleTimer);
    }
    scrollIdleTimer = window.setTimeout(() => {
      scrollActive = false;
      scheduleRun();
    }, 180);
  };

  const getScrollContainer = (main: HTMLElement): HTMLElement => {
    const anchor =
      main.querySelector<HTMLElement>(TURN_CONTAINER_SELECTOR) ??
      main.querySelector<HTMLElement>('[data-message-id]') ??
      main;

    let el: HTMLElement | null = anchor;
    while (el && el !== document.body && el !== document.documentElement) {
      const oy = getComputedStyle(el).overflowY;
      const isScrollable = (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1;
      if (isScrollable) {
        return el;
      }
      el = el.parentElement;
    }

    const scroller = document.scrollingElement;
    return scroller instanceof HTMLElement ? scroller : document.documentElement;
  };

  const run = (): void => {
    scheduled = false;
    if (isApplying) {
      return;
    }

    const main = document.querySelector('main');
    if (!main) {
      return;
    }

    const scroller = getScrollContainer(main);
    const distanceFromBottomBefore =
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    const shouldStickToBottom =
      distanceFromBottomBefore >= -1 && distanceFromBottomBefore <= BOTTOM_STICK_THRESHOLD_PX;
    if (config.keep === 1 && scrollActive) {
      // Avoid trimming while the user is actively scrolling. ChatGPT's virtualized
      // thread can otherwise produce transient phantom space when keep=1.
      return;
    }

    isApplying = true;
    if (hardResetPending) {
      // After retention/config changes, clear stale trim artifacts first.
      // This prevents mixed old/new hidden states that can leave phantom scroll space.
      unhideAll(main);
      unhideAll(document);
      hardResetPending = false;
    }

    if (!config.enabled) {
      unhideAll(main);
      unhideAll(document);
      const totalRounds = countUserRoundsInDom(document);
      onStatusUpdate?.({
        totalRounds,
        visibleRounds: totalRounds,
        trimmedRounds: 0,
        keep: config.keep,
      });
      isApplying = false;
      return;
    }

    // Keep=1 is unstable only during live "edge" states (writing/pending reply).
    // Outside those states, honor the user's exact keep=1.
    const effectiveKeep =
      config.keep === 1 && shouldUseKeepOneStabilityGuard(main)
        ? DOM_STABLE_MIN_KEEP
        : Math.max(1, config.keep);
    const result = applyTrim(main, effectiveKeep);
    onStatusUpdate?.({
      totalRounds: result.totalRounds,
      visibleRounds: result.visibleRounds,
      trimmedRounds: Math.max(0, result.totalRounds - result.visibleRounds),
      keep: config.keep,
    });

    isApplying = false;
    if (!result.changed) {
      return;
    }

    if (shouldStickToBottom && !scrollActive) {
      // Preserve ChatGPT's default behavior: if user was already near bottom,
      // keep them anchored there after trim layout changes.
      scroller.scrollTop = scroller.scrollHeight;
      requestAnimationFrame(() => {
        scroller.scrollTop = scroller.scrollHeight;
      });
    }
  };

  const scheduleRun = (): void => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    requestAnimationFrame(run);
  };

  const ensureObserver = (): void => {
    const main = document.querySelector('main');
    if (!main) {
      observer?.disconnect();
      observer = null;
      observerRoot = null;
      if (scrollContainer) {
        scrollContainer.removeEventListener('scroll', onScroll, true);
        scrollContainer = null;
      }
      return;
    }

    const nextScroller = getScrollContainer(main);
    if (nextScroller !== scrollContainer) {
      if (scrollContainer) {
        scrollContainer.removeEventListener('scroll', onScroll, true);
      }
      scrollContainer = nextScroller;
      scrollContainer.addEventListener('scroll', onScroll, { passive: true, capture: true });
    }

    if (observer && observerRoot === main) {
      return;
    }

    observer?.disconnect();
    observer = new MutationObserver(() => {
      if (isApplying) {
        return;
      }
      scheduleRun();
    });
    observer.observe(main, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-hidden', 'data-state'],
    });
    observerRoot = main;
  };

  const healthTimer = window.setInterval(() => {
    ensureObserver();
    scheduleRun();
  }, 1000);

  ensureObserver();
  scheduleRun();

  return {
    setConfig(nextConfig: DomTrimmerConfig): void {
      const prevEnabled = config.enabled;
      const prevKeep = config.keep;
      config = {
        enabled: nextConfig.enabled,
        keep: Math.max(1, nextConfig.keep),
      };
      if (prevEnabled !== config.enabled || prevKeep !== config.keep) {
        hardResetPending = true;
      }
      logDebug('DOM trimmer config updated:', config);
      ensureObserver();
      scheduleRun();
    },

    runNow(): void {
      ensureObserver();
      scheduleRun();
    },

    teardown(): void {
      window.clearInterval(healthTimer);
      observer?.disconnect();
      observer = null;
      if (scrollIdleTimer !== null) {
        window.clearTimeout(scrollIdleTimer);
        scrollIdleTimer = null;
      }
      if (scrollContainer) {
        scrollContainer.removeEventListener('scroll', onScroll, true);
        scrollContainer = null;
      }

      const main = document.querySelector('main');
      if (main) {
        unhideAll(main);
      }
    },
  };
}
