/**
 * LightSession for ChatGPT - Page Script Injector
 *
 * This content script runs at document_start to inject the page script
 * into the page context BEFORE any other scripts run.
 *
 * This is critical for patching window.fetch before ChatGPT's code uses it.
 */

import browser from '../shared/browser-polyfill';

(function injectPageScript(): void {
  // Create script element pointing to our page script
  const script = document.createElement('script');
  script.src = browser.runtime.getURL('dist/page-script.js');

  // Insert at the very beginning of document
  const target = document.head || document.documentElement;
  target.insertBefore(script, target.firstChild);

  // Remove script tag after load (cleanup, keeps DOM tidy)
  script.onload = (): void => {
    script.remove();
  };

  // Handle load errors (shouldn't happen, but good to log)
  script.onerror = (): void => {
    console.error('[LightSession] Failed to load page script');
    script.remove();
  };
})();
