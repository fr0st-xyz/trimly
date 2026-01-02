/**
 * LightSession for ChatGPT - Browser API Polyfill
 * Firefox natively supports the browser API via @types/firefox-webext-browser
 * This module re-exports the global browser object for consistent imports
 */

// The global browser object is provided by Firefox and typed by @types/firefox-webext-browser
// We re-export it for consistent module imports across the codebase
export default browser;
