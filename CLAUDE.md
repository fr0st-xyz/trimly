# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

```bash
npm install          # Install dependencies
npm run build        # Build extension (esbuild)
npm run dev          # Run in Firefox Developer Edition with auto-reload
npm run test         # Run unit tests (vitest)
npm run test:watch   # Run tests in watch mode
npm run lint         # ESLint check
npm run lint:fix     # ESLint autofix
npm run build:types  # TypeScript type check (no emit)
```

## Architecture

**Firefox extension (Manifest V3)** that trims old DOM nodes from ChatGPT conversations to fix UI lag.

### Core Components

| Component | Path | Purpose |
|-----------|------|---------|
| Content Script | `extension/src/content/` | Injected into ChatGPT pages, handles trimming |
| Background | `extension/src/background/` | Settings storage, message routing |
| Popup | `extension/src/popup/` | Extension toolbar UI |
| Shared | `extension/src/shared/` | Types, constants, storage, logger |

### Content Script Flow

```
content.ts (entry) → trimmer.ts (state machine) → dom-helpers.ts (find nodes)
                                                 → observers.ts (MutationObserver)
```

**State machine:** `IDLE ↔ OBSERVING` (two states, `trimScheduled` flag controls trimming)

**Trimming flow:**
1. MutationObserver detects DOM changes (debounced 75ms)
2. `evaluateTrim()` checks preconditions (enabled, not streaming, etc.)
3. `buildActiveThread()` finds message nodes using tiered selectors
4. `executeTrim()` removes excess nodes via `requestIdleCallback`

### Selector Strategy

ChatGPT DOM selectors in `shared/constants.ts` → `SELECTOR_TIERS`:
- **Tier A:** Data attributes (`[data-message-id]`)
- **Tier B:** Test IDs and specific classes
- **Tier C:** Structural fallbacks with heuristics

If ChatGPT UI changes, update selectors in `SELECTOR_TIERS`.

## Project Structure

```
extension/src/
├── content/         # Content scripts (trimmer, observers, dom-helpers)
├── background/      # Background service worker
├── popup/           # Popup HTML/CSS/TS
└── shared/          # Types, constants, storage, logger
tests/               # Unit tests (vitest + happy-dom)
build.cjs            # esbuild build script (CommonJS)
```

## Conventions

- ES modules (`"type": "module"` in package.json)
- ESLint 9 flat config (`eslint.config.js`)
- Strict TypeScript (`noUncheckedIndexedAccess: true`)
- Prefix logs with `[LS:DEBUG]`, `[LS:INFO]`, `[LS:WARN]`, `[LS:ERROR]`
