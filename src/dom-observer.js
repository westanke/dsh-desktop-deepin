/**
 * Renderer-side observer script source, exposed as a string so the shell can
 * hand it to `webContents.executeJavaScript` once the page is ready.
 *
 * The observer detects the "agent finished a task" transition by watching
 * the kernel's web UI for an in-flight indicator (spinner / generating pill /
 * "thinking" text). When the indicator disappears, it calls
 * `window.shell.notify`, the locked-down bridge the preload exposes.
 *
 * Why observe the DOM rather than poll the kernel API:
 *
 *   1. The kernel's `/api/v1.*` endpoints require browser-trust markers
 *      (`Host`, `Sec-Fetch-Site`, `Origin`) the shell cannot produce from a
 *      separate process.
 *   2. The kernel is in developer preview; documented endpoints move between
 *      releases. Polling them couples the shell to a moving target.
 *   3. The "agent finished" signal *is* visible in the DOM — the indicator
 *      the kernel's UI plugins render while a turn is running.
 *
 * The matchers are kept loose and extensible: when a future kernel release
 * introduces a new indicator, adding it here is a one-line change.
 *
 * @module dom-observer
 */

/**
 * The complete observer script, as a string. The shell executes this in the
 * renderer's main world after every successful page load.
 */
export const OBSERVER_SOURCE = `(function () {
  if (window.__DSH_SHELL_OBSERVER__ === true) return
  window.__DSH_SHELL_OBSERVER__ = true

  var BUSY_SELECTORS = [
    '[aria-busy="true"]',
    '[data-state="generating"]',
    '[data-state="streaming"]',
    '[data-state="busy"]',
    '[data-loading="true"]',
    '.dsh-generating',
    '.dsh-thinking',
    '.dsh-streaming'
  ]

  var BUSY_TEXT_PATTERNS = [
    /generating/i,
    /thinking\\.{0,3}$/i,
    /思考中/i,
    /生成中/i
  ]

  // Text inside these elements is never rendered. A match there would be a
  // false positive: a CSS class named ".generating" would otherwise keep the
  // shell busy for the rest of the session.
  var SKIP_TEXT_PARENTS = {
    SCRIPT: true,
    STYLE: true,
    NOSCRIPT: true,
    TEMPLATE: true
  }

  function isBusyText() {
    // Walk the text nodes once instead of reading textContent on every
    // element. Reading textContent per element re-concatenates each
    // element's whole subtree, so the scan costs O(elements * page text):
    // 49 ms on a 11k-element chat page, against 4 ms for this walk.
    if (!document.body) return false
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    var node = walker.nextNode()
    while (node !== null) {
      var parent = node.parentElement
      if (parent === null || SKIP_TEXT_PARENTS[parent.tagName] !== true) {
        var text = node.nodeValue
        if (text) {
          for (var k = 0; k < BUSY_TEXT_PATTERNS.length; k++) {
            if (BUSY_TEXT_PATTERNS[k].test(text)) return true
          }
        }
      }
      node = walker.nextNode()
    }
    return false
  }

  function isBusy() {
    for (var i = 0; i < BUSY_SELECTORS.length; i++) {
      if (document.querySelector(BUSY_SELECTORS[i]) !== null) return true
    }
    return isBusyText()
  }

  var busy = isBusy()

  // Report the initial state too: the shell cannot tell whether a turn is
  // running until it is told, and "not busy" is the wrong default when a
  // launch lands mid-task.
  reportBusy(busy)

  function reportBusy(now) {
    if (typeof window.shell === 'object' && typeof window.shell.setBusy === 'function') {
      window.shell.setBusy(now)
    }
  }

  function onTransition(now) {
    if (busy === now) return
    busy = now
    reportBusy(now)
    if (!now && typeof window.shell === 'object' && typeof window.shell.notify === 'function') {
      window.shell.notify('DeepSeek Harness', 'The agent finished its current task.')
    }
  }

  var observer = new MutationObserver(function () {
    onTransition(isBusy())
  })

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-busy', 'data-state', 'data-loading', 'class']
  })

  // Close the window where a turn completes between observer attach and the
  // first MutationObserver tick.
  var attempts = 0
  var initial = setInterval(function () {
    attempts++
    onTransition(isBusy())
    if (attempts >= 5) clearInterval(initial)
  }, 1000)
})()`