/**
 * Reports the page's theme choice to the main process.
 *
 * The kernel's web UI can run light, dark, or follow the system, and it decides
 * which by setting `data-ds-theme-source` on the root element. Electron's own
 * chrome — the window frame, native menus, the tray tooltip, anything rendered
 * by the toolkit rather than the page — reads `nativeTheme` instead. Left
 * alone the two disagree, and the visible result is a dark application inside
 * a light frame or the reverse.
 *
 * The attribute is the only signal available: it is set by the application
 * rather than by this shell, and reading it keeps the two in step without the
 * shell having to know which UI control produced it.
 *
 * @module theme-bridge
 */

/**
 * The root attribute the web UI sets.
 *
 * Namespaced because it is written by the application, not by this shell, and
 * a generic `data-theme` would collide with whatever the framework also sets.
 */
const THEME_ATTRIBUTE = 'data-ds-theme-source'

/** Values the attribute takes, and what each means to Electron. */
export const THEME_SOURCES = Object.freeze({
  light: 'light',
  dark: 'dark',
  system: 'system',
})

/**
 * Translates the page's attribute value into an Electron `themeSource`.
 *
 * @param {string | null | undefined} value - the attribute value
 * @returns {'system' | 'light' | 'dark'} `system` for anything unrecognised,
 *   because an unknown value is better treated as "let the OS decide" than as
 *   a guess that fights the user's desktop
 */
export function resolveThemeSource(value) {
  if (value === THEME_SOURCES.light || value === THEME_SOURCES.dark) return value
  return THEME_SOURCES.system
}

/**
 * The script to run in the page.
 *
 * Written as a string rather than as a module because it runs in the renderer:
 * the main process injects it, and the page's own bundle is not ours to import
 * from. It reads the attribute and hands the value to the preload's bridge,
 * which is what actually crosses to the main process.
 *
 * @returns {string} JavaScript to evaluate in the page
 */
export function themeBridgeScript() {
  return `(() => {
    const attribute = ${JSON.stringify(THEME_ATTRIBUTE)}
    const report = () => {
      try {
        const root = document.documentElement
        const value = root ? root.getAttribute(attribute) : null
        // The bridge is absent when this ran outside the shell's window (a
        // plain browser, a devtools console), which is not an error.
        window.__dshSetTheme?.(value)
      } catch {
        // intentionally empty
      }
    }
    if (window.__dshThemeObserver) return
    const observer = new MutationObserver(report)
    const start = () => {
      if (!document.documentElement) return false
      observer.observe(document.documentElement, { attributes: true, attributeFilter: [attribute] })
      return true
    }
    // The element may not exist yet when the script runs, so retry when the
    // document is parsed rather than giving up on a page still loading.
    if (!start()) {
      document.addEventListener('DOMContentLoaded', start, { once: true })
    }
    window.__dshThemeObserver = observer
    report()
  })()`
}
