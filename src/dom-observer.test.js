/**
 * Tests for the renderer-side busy observer.
 *
 * The observer script runs inside the kernel's web UI, so it cannot be
 * imported as a module. These tests therefore work on the script source
 * itself: they assert the shape of the scan, and they run the real script
 * against a hand-built fake DOM to check what it actually decides.
 *
 * @module dom-observer.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import vm from 'node:vm'

import { OBSERVER_SOURCE } from './dom-observer.js'

/**
 * One node of the fake DOM tree.
 *
 * @typedef {object} FakeNode
 * @property {string} [tag] tag name, defaults to DIV
 * @property {FakeNode[]} [children] child elements
 * @property {string} [text] a text node rendered inside this element
 * @property {Record<string, string>} [attrs] attributes, keyed by name
 * @property {string} [class] class attribute value
 */

/**
 * A minimal DOM good enough for the observer script: elements, text nodes,
 * a text-node walker and the handful of DOM APIs the script touches.
 *
 * `textContentReads` counts how often an element's textContent is read.
 * That is the number this whole file is about: reading textContent on every
 * element re-concatenates every subtree, so the cost grows with
 * elements * text.
 *
 * @param {FakeNode[]} spec
 */
function buildDom(spec) {
  const stats = { textContentReads: 0, textContentReadsByTag: /** @type {Record<string, number>} */ ({}) }
  let nextId = 1

  /**
   * @param {FakeNode} node
   * @returns {any}
   */
  const create = (node) => {
    /** @type {any[]} */
    const children = []
    /** @type {any} */
    const element = {
      nodeType: 1,
      tagName: node.tag ?? 'DIV',
      __attrs: node.attrs ?? {},
      __class: node.class ?? '',
      children,
      childNodes: children,
      parentElement: null,
      parentNode: null,
      get textContent() {
        stats.textContentReads++
        stats.textContentReadsByTag[element.tagName] =
          (stats.textContentReadsByTag[element.tagName] ?? 0) + 1
        let out = node.text ?? ''
        for (const child of children) out += child.textContent ?? ''
        return out
      },
    }

    for (const childSpec of node.children ?? []) {
      const child = create(childSpec)
      child.parentElement = element
      child.parentNode = element
      children.push(child)
    }

    if (node.text !== undefined) {
      const textNode = {
        nodeType: 3,
        nodeValue: node.text,
        parentElement: element,
        parentNode: element,
        get textContent() {
          return node.text
        },
      }
      children.push(textNode)
    }

    return element
  }

  const root = create({ tag: 'BODY', children: spec })
  /** @type {any[]} */
  const allElements = []
  /** @type {any[]} */
  const allTextNodes = []
  /**
   * @param {any} node
   */
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.nodeType === 1) {
        allElements.push(child)
        walk(child)
      } else {
        allTextNodes.push(child)
      }
    }
  }
  walk(root)

  const document = {
    body: root,
    /**
     * @param {string} selector
     */
    querySelector(selector) {
      // Only the busy selectors are supported; anything else returns null.
      const match = allElements.find((el) => {
        const attr = /^\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(selector)
        if (attr) return el.__attrs?.[attr[1] ?? ''] === (attr[2] ?? '')
        if (selector.startsWith('.')) return el.__class?.split(/\s+/).includes(selector.slice(1))
        return false
      })
      return match ?? null
    },
    querySelectorAll() {
      return allElements
    },
    /**
     * @param {any} _root
     * @param {number} whatToShow
     */
    createTreeWalker(_root, whatToShow) {
      let index = 0
      return {
        nextNode() {
          if (whatToShow !== 4 /* NodeFilter.SHOW_TEXT */) return null
          return allTextNodes[index++] ?? null
        },
      }
    },
  }

  return { document, stats }
}

/**
 * Run the observer script against a fake DOM.
 *
 * @param {FakeNode[]} spec
 */
function runObserver(spec) {
  const { document, stats } = buildDom(spec)
  /** @type {boolean[]} */
  const reported = []
  const sandbox = {
    document,
    NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: class {
      /** @param {() => void} callback */
      constructor(callback) {
        this.callback = callback
      }
      observe() {}
      disconnect() {}
    },
    setInterval: () => 0,
    clearInterval: () => {},
    window: {
      __DSH_SHELL_OBSERVER__: undefined,
      shell: {
        /** @param {boolean} value */
        setBusy: (value) => {
          reported.push(value)
        },
        notify: () => {},
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(OBSERVER_SOURCE, sandbox)
  return { reported, stats }
}

describe('OBSERVER_SOURCE', () => {
  it('reads no element textContent, because that scan is quadratic', () => {
    // Reading textContent on every element re-concatenates each element's
    // whole subtree: the scan costs elements * page text, and a long
    // conversation page has thousands of elements.
    assert.ok(
      !OBSERVER_SOURCE.includes("querySelectorAll('*')"),
      'the observer must not walk every element',
    )
    assert.ok(
      !OBSERVER_SOURCE.includes('.textContent'),
      'the observer must not read element textContent',
    )
  })

  it('walks text nodes once instead', () => {
    assert.ok(OBSERVER_SOURCE.includes('createTreeWalker'))
  })

  it('still watches the busy attributes the kernel renders', () => {
    // The attribute selectors are cheap and they are what actually fires:
    // the kernel sets aria-busy on the chat surface while a turn runs.
    for (const selector of [
      '[aria-busy="true"]',
      '[data-state="generating"]',
      '[data-state="streaming"]',
      '[data-state="busy"]',
      '[data-loading="true"]',
    ]) {
      assert.ok(OBSERVER_SOURCE.includes(selector), `missing selector ${selector}`)
    }
  })

  it('keeps the text patterns as a fallback for unknown kernels', () => {
    for (const pattern of ['/generating/i', '/thinking', '/思考中/i', '/生成中/i']) {
      assert.ok(OBSERVER_SOURCE.includes(pattern), `missing pattern ${pattern}`)
    }
  })

  it('ignores text that is never rendered', () => {
    // A stylesheet or an inline bundle that happens to contain the word
    // "generating" must not pin the shell in the busy state forever.
    for (const tag of ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']) {
      assert.ok(OBSERVER_SOURCE.includes(tag), `missing skip list entry ${tag}`)
    }
  })

  it('is idempotent, because it is injected on every load', () => {
    assert.ok(OBSERVER_SOURCE.includes('window.__DSH_SHELL_OBSERVER__'))
  })

  it('reports the current state once on load', () => {
    // Otherwise Electron's chrome would not know whether a turn is running
    // until the first DOM change happens.
    assert.ok(OBSERVER_SOURCE.trimEnd().endsWith('})()'))
  })
})

describe('the observer against a fake DOM', () => {
  it('reports busy when a busy attribute is present', () => {
    const { reported } = runObserver([
      { tag: 'DIV', attrs: { 'aria-busy': 'true' } },
    ])
    assert.deepEqual(reported, [true])
  })

  it('reports idle for an ordinary page', () => {
    const { reported } = runObserver([
      { tag: 'DIV', text: 'hello' },
      { tag: 'P', text: 'a conversation about migrating a folder' },
    ])
    assert.deepEqual(reported, [false])
  })

  it('reports busy when the visible text says so', () => {
    const { reported } = runObserver([{ tag: 'SPAN', text: '生成中' }])
    assert.deepEqual(reported, [true])
  })

  it('ignores busy wording that is only in a script or style', () => {
    const { reported } = runObserver([
      { tag: 'SCRIPT', text: 'const state = "generating"' },
      { tag: 'STYLE', text: '.generating { color: red }' },
    ])
    assert.deepEqual(reported, [false])
  })

  it('never reads element textContent while deciding', () => {
    // This is the property that keeps the shell responsive: a chat page
    // with thousands of elements must not cost a full-text scan per
    // element.
    const { stats } = runObserver([
      { tag: 'DIV', children: [{ tag: 'SPAN', text: 'a' }] },
      { tag: 'DIV', children: [{ tag: 'SPAN', text: 'b' }] },
      { tag: 'DIV', children: [{ tag: 'SPAN', text: 'c' }] },
    ])
    assert.equal(stats.textContentReads, 0)
  })

  it('reports only once per load, not once per element', () => {
    const { reported } = runObserver([
      { tag: 'DIV', text: 'one' },
      { tag: 'DIV', text: 'two' },
      { tag: 'DIV', text: 'three' },
    ])
    assert.equal(reported.length, 1)
  })
})
