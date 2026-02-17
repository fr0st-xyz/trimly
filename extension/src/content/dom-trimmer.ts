/**
 * Trimly for ChatGPT - DOM trim fallback
 *
 * Keeps only the last N visible turns in the rendered DOM so settings
 * can apply instantly without reloading the page.
 */

import { logDebug } from '../shared/logger';

const HIDDEN_ATTR = 'data-ls-dom-trimmed';
const HIDDEN_ACTION_ATTR = 'data-ls-dom-trimmed-action';
const HIDDEN_ROLES = new Set(['system', 'tool', 'thinking']);
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

function getRoleFromTurn(turn: HTMLElement): string | null {
  const ownRole = turn.getAttribute('data-message-author-role');
  if (ownRole) {
    return ownRole;
  }

  const nestedRole = turn.querySelector<HTMLElement>('[data-message-author-role]');
  return nestedRole?.getAttribute('data-message-author-role') ?? null;
}

function getConversationTurns(root: ParentNode): HTMLElement[] {
  const byMessageId = Array.from(
    root.querySelectorAll<HTMLElement>('[data-message-id]')
  );
  if (byMessageId.length > 0) {
    const normalized = byMessageId.map((el) => {
      const outerTurn = el.closest<HTMLElement>(
        '[data-testid^="conversation-turn"], [data-turn-id], article[data-turn]'
      );
      return outerTurn ?? el;
    });
    return Array.from(new Set(normalized));
  }

  const byTurnTestId = Array.from(
    root.querySelectorAll<HTMLElement>(
      '[data-testid^="conversation-turn"], [data-turn-id], article[data-turn]'
    )
  );
  if (byTurnTestId.length > 0) {
    return byTurnTestId;
  }

  return [];
}

function unhideTurn(turn: HTMLElement): boolean {
  if (!turn.hasAttribute(HIDDEN_ATTR)) {
    return false;
  }
  turn.removeAttribute(HIDDEN_ATTR);
  turn.style.removeProperty('display');
  turn.style.removeProperty('height');
  turn.style.removeProperty('min-height');
  turn.style.removeProperty('margin');
  turn.style.removeProperty('padding');
  turn.style.removeProperty('overflow');
  turn.style.removeProperty('pointer-events');
  return true;
}

function hideTurn(turn: HTMLElement): boolean {
  if (turn.hasAttribute(HIDDEN_ATTR)) {
    return false;
  }
  turn.setAttribute(HIDDEN_ATTR, '1');
  // Force full layout collapse so hidden turns never reserve scroll space.
  turn.style.setProperty('display', 'none', 'important');
  turn.style.setProperty('height', '0', 'important');
  turn.style.setProperty('min-height', '0', 'important');
  turn.style.setProperty('margin', '0', 'important');
  turn.style.setProperty('padding', '0', 'important');
  turn.style.setProperty('overflow', 'hidden', 'important');
  turn.style.setProperty('pointer-events', 'none', 'important');
  return true;
}

function unhideAll(root: ParentNode): void {
  const trimmed = root.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`);
  for (const turn of trimmed) {
    unhideTurn(turn);
  }

  const trimmedActions = root.querySelectorAll<HTMLElement>(`[${HIDDEN_ACTION_ATTR}]`);
  for (const action of trimmedActions) {
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
  return el.closest<HTMLElement>('[data-message-id]')?.getAttribute('data-message-id') ?? null;
}

function collectVisibleMessageIds(visibleTurns: Set<HTMLElement>): Set<string> {
  const ids = new Set<string>();
  for (const turn of visibleTurns) {
    const own = turn.getAttribute('data-message-id');
    if (own) {
      ids.add(own);
    }
    const nested = turn.querySelectorAll<HTMLElement>('[data-message-id]');
    for (const el of nested) {
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

  for (const control of controls) {
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
  for (const el of retryTextEls) {
    if (!isRetryLikeText(el.textContent || '')) {
      continue;
    }

    const target =
      el.closest<HTMLElement>('button, [role="button"], [role="menuitem"], [data-testid]') || el;
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

function applyTrim(root: ParentNode, keep: number): ApplyTrimResult {
  const turns = getConversationTurns(root);
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
    return { changed, totalRounds, visibleRounds: totalRounds };
  }

  const startPos = userPositions[userPositions.length - keep] ?? 0;
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
  return { changed, totalRounds, visibleRounds: Math.min(totalRounds, keep) };
}

function countUserRoundsInDom(root: ParentNode): number {
  const nodes = root.querySelectorAll<HTMLElement>('[data-message-id][data-message-author-role="user"]');
  return nodes.length;
}

export function installDomTrimmer(
  onStatusUpdate?: (status: DomTrimStatus) => void
): DomTrimmerController {
  let config: DomTrimmerConfig = { enabled: true, keep: 10 };
  let observer: MutationObserver | null = null;
  let observerRoot: HTMLElement | null = null;
  let scheduled = false;
  let isApplying = false;
  let forceBottomAnchor = false;

  const getScrollContainer = (): HTMLElement => {
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

    const scroller = getScrollContainer();
    const prevTop = scroller.scrollTop;
    const prevHeight = scroller.scrollHeight;
    const prevBottomOffset = prevHeight - (prevTop + scroller.clientHeight);
    const wasNearBottom = prevBottomOffset <= 8;

    isApplying = true;
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

    const result = applyTrim(main, Math.max(1, config.keep));
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

    // Avoid jitter from aggressive delta correction on long chats.
    // Keep bottom anchor when user is near bottom, or immediately after
    // settings changes so the kept latest messages are visible.
    const shouldAnchorBottom = wasNearBottom || forceBottomAnchor;
    forceBottomAnchor = false;
    if (shouldAnchorBottom) {
      const nextHeight = scroller.scrollHeight;
      scroller.scrollTop = Math.max(0, nextHeight - scroller.clientHeight);
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
      return;
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
      if (config.enabled && (prevEnabled !== config.enabled || prevKeep !== config.keep)) {
        forceBottomAnchor = true;
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

      const main = document.querySelector('main');
      if (main) {
        unhideAll(main);
      }
    },
  };
}
