/**
 * @module theme-bridge
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { THEME_SOURCES, resolveThemeSource, themeBridgeScript } from './theme-bridge.js'

describe('resolveThemeSource', () => {
  it('passes the two explicit choices through', () => {
    assert.equal(resolveThemeSource(THEME_SOURCES.light), 'light')
    assert.equal(resolveThemeSource(THEME_SOURCES.dark), 'dark')
  })

  it('follows the system when that is what the page asked for', () => {
    assert.equal(resolveThemeSource(THEME_SOURCES.system), 'system')
  })

  it('falls back to the system for anything it does not recognise', () => {
    // An unknown value is better treated as "let the OS decide" than as a
    // guess that fights the user's desktop setting.
    for (const value of [null, undefined, '', 'sepia', 'LIGHT', 'dark mode']) {
      assert.equal(resolveThemeSource(value), 'system', `${String(value)} must not pick a theme`)
    }
  })
})

describe('themeBridgeScript', () => {
  it('reports the attribute the web UI writes, not a generic one', () => {
    const script = themeBridgeScript()
    assert.ok(script.includes('data-ds-theme-source'))
    // A generic name would collide with whatever the framework also sets.
    assert.ok(!script.includes('"data-theme"'))
  })

  it('observes only that attribute', () => {
    // Every attribute on <html> would otherwise fire on unrelated changes.
    assert.ok(themeBridgeScript().includes('attributeFilter: [attribute]'))
  })

  it('guards against the bridge being absent', () => {
    // The script also runs in a plain browser or a devtools console, where the
    // preload never loaded and an exception would be noise.
    assert.ok(themeBridgeScript().includes('window.__dshSetTheme?.('))
  })

  it('is idempotent, because it is injected on every load', () => {
    // A second observer on the same document would report every change twice.
    assert.ok(themeBridgeScript().includes('if (window.__dshThemeObserver) return'))
  })

  it('waits for the document element instead of giving up', () => {
    // The script runs on `did-finish-load`, but a document that is still
    // parsing may not have a root element yet.
    assert.ok(themeBridgeScript().includes('DOMContentLoaded'))
  })

  it('reports the current value once on load', () => {
    // Otherwise Electron's chrome would keep the OS theme until the user
    // changed something in the application.
    assert.ok(themeBridgeScript().trimEnd().endsWith('})()'))
  })
})
