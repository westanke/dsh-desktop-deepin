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
 * `treeWalkerCalls` counts how often the script walks the tree. The observer
 * must not re-walk the whole page for every DOM change: that is the cost
 * that made a streaming turn pin the renderer.
 *
 * @param {FakeNode[]} spec
 */
function buildDom(spec) {
  const stats = {
    textContentReads: 0,
    textContentReadsByTag: /** @type {Record<string, number>} */ ({}),
    treeWalkerCalls: 0,
    querySelectorCalls: 0,
  }
  let nextId = 1

  /** @type {any} */
  let root = null

  /**
   * @param {any} node
   * @returns {boolean}
   */
  const isConnected = (node) => {
    let current = node
    while (current) {
      if (current === root) return true
      current = current.parentElement
    }
    return false
  }

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
      __attrs: { ...(node.attrs ?? {}) },
      __class: node.class ?? '',
      children,
      childNodes: children,
      parentElement: null,
      parentNode: null,
      get isConnected() {
        return isConnected(element)
      },
      get className() {
        return element.__class
      },
      set className(value) {
        element.__class = value
      },
      /**
       * @param {string} name
       * @param {string} value
       */
      setAttribute(name, value) {
        element.__attrs[name] = String(value)
      },
      /**
       * @param {string} name
       * @returns {string | null}
       */
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(element.__attrs, name)
          ? element.__attrs[name]
          : null
      },
      /**
       * @param {any} child
       */
      appendChild(child) {
        child.parentElement = element
        child.parentNode = element
        children.push(child)
        return child
      },
      /**
       * @param {any} child
       */
      removeChild(child) {
        const index = children.indexOf(child)
        if (index >= 0) children.splice(index, 1)
        child.parentElement = null
        child.parentNode = null
        return child
      },
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
      const textNode = createTextNode(node.text)
      textNode.parentElement = element
      textNode.parentNode = element
      children.push(textNode)
    }

    return element
  }

  /**
   * @param {string} text
   * @returns {any}
   */
  const createTextNode = (text) => ({
    nodeType: 3,
    nodeValue: text,
    parentElement: null,
    parentNode: null,
    get isConnected() {
      return isConnected(this)
    },
    get textContent() {
      return this.nodeValue
    },
  })

  root = create({ tag: 'BODY', children: spec })

  /**
   * @param {any} node
   * @param {any[]} out
   * @returns {any[]}
   */
  const collectTextNodes = (node, out) => {
    if (node.nodeType === 3) {
      out.push(node)
      return out
    }
    for (const child of node.children ?? []) collectTextNodes(child, out)
    return out
  }

  /**
   * @param {any} node
   * @param {any[]} out
   * @returns {any[]}
   */
  const collectElements = (node, out) => {
    if (node.nodeType === 1) {
      out.push(node)
      for (const child of node.children ?? []) collectElements(child, out)
    }
    return out
  }

  const document = {
    body: root,
    /**
     * @param {string} selector
     */
    querySelector(selector) {
      stats.querySelectorCalls++
      // Only the busy selectors are supported; anything else returns null.
      const allElements = collectElements(root, [])
      const match = allElements.find((el) => {
        const attr = /^\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(selector)
        if (attr) return el.__attrs?.[attr[1] ?? ''] === (attr[2] ?? '')
        if (selector.startsWith('.')) return el.__class?.split(/\s+/).includes(selector.slice(1))
        return false
      })
      return match ?? null
    },
    querySelectorAll() {
      return collectElements(root, [])
    },
    /**
     * @param {string} tag
     * @returns {any}
     */
    createElement(tag) {
      return create({ tag })
    },
    /**
     * @param {string} text
     * @returns {any}
     */
    createTextNode(text) {
      return createTextNode(text)
    },
    /**
     * @param {any} _root
     * @param {number} whatToShow
     */
    createTreeWalker(_root, whatToShow) {
      stats.treeWalkerCalls++
      const nodes = whatToShow === 4 /* NodeFilter.SHOW_TEXT */ ? collectTextNodes(_root, []) : []
      let index = 0
      return {
        nextNode() {
          return nodes[index++] ?? null
        },
      }
    },
  }

  return { document, stats, root, createTextNode }
}

/**
 * Run the observer script against a fake DOM.
 *
 * @param {FakeNode[]} spec
 */
function runObserver(spec) {
  const { document, stats, root, createTextNode } = buildDom(spec)
  /** @type {boolean[]} */
  const reported = []
  /** @type {any[]} */
  const observers = []
  const sandbox = {
    document,
    NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: class {
      /** @param {(records: any[]) => void} callback */
      constructor(callback) {
        this.callback = callback
        observers.push(this)
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
  return {
    reported,
    stats,
    root,
    createTextNode,
    /**
     * Deliver a set of mutation records to the observer, the way the browser
     * would after the DOM changed.
     *
     * @param {any[]} records
     */
    mutate(records) {
      for (const observer of observers) observer.callback(records)
    },
  }
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
    // One alternation instead of four separate patterns: four regex tests per
    // text node were 2.9 ms of a 3.9 ms scan on an 11k-element page.
    assert.ok(
      OBSERVER_SOURCE.includes('BUSY_TEXT_PATTERN'),
      'the observer must keep a text pattern',
    )
    for (const pattern of ['generating', 'thinking', '思考中', '生成中']) {
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

describe('the observer tracks the busy text incrementally', () => {
  it('walks the page once on load', () => {
    const { stats } = runObserver([
      { tag: 'DIV', text: 'one' },
      { tag: 'DIV', text: 'two' },
    ])
    assert.equal(stats.treeWalkerCalls, 1)
  })

  it('does not re-walk the page when the text changes', () => {
    // This is the hot path: the kernel rewrites the streaming answer many
    // times per second. Re-scanning the whole page on every write is what
    // pinned the renderer during a long session.
    const { stats, root, createTextNode, mutate } = runObserver([
      { tag: 'DIV', text: 'one' },
    ])
    const before = stats.treeWalkerCalls

    const text = createTextNode('生成中')
    root.appendChild(text)
    mutate([
      { type: 'childList', addedNodes: [text], removedNodes: [] },
    ])

    assert.equal(stats.treeWalkerCalls, before, 'a text change must not re-walk the page')
  })

  it('notices busy text that appears while the session runs', () => {
    const { reported, root, createTextNode, mutate } = runObserver([
      { tag: 'DIV', text: 'one' },
    ])
    assert.deepEqual(reported, [false])

    const text = createTextNode('生成中')
    root.appendChild(text)
    mutate([{ type: 'childList', addedNodes: [text], removedNodes: [] }])

    assert.deepEqual(reported, [false, true])
  })

  it('notices busy text that changes in place', () => {
    // The kernel streams an answer by rewriting one text node over and
    // over; the observer has to see the new wording without re-walking.
    const { reported, root, createTextNode, mutate } = runObserver([
      { tag: 'DIV', text: 'one' },
    ])
    const text = createTextNode('one')
    root.appendChild(text)
    mutate([{ type: 'childList', addedNodes: [text], removedNodes: [] }])

    text.nodeValue = '思考中...'
    mutate([{ type: 'characterData', target: text }])

    assert.deepEqual(reported, [false, true])
  })

  it('clears the busy state when the busy text leaves the page', () => {
    const { reported, root, createTextNode, mutate } = runObserver([
      { tag: 'DIV', text: 'one' },
    ])
    const text = createTextNode('生成中')
    root.appendChild(text)
    mutate([{ type: 'childList', addedNodes: [text], removedNodes: [] }])
    assert.deepEqual(reported, [false, true])

    root.removeChild(text)
    mutate([{ type: 'childList', addedNodes: [], removedNodes: [text] }])

    assert.deepEqual(reported, [false, true, false])
  })

  it('costs one selector query per check, not one page walk', () => {
    const { stats, root, createTextNode, mutate } = runObserver([
      { tag: 'DIV', text: 'one' },
    ])
    const queriesBefore = stats.querySelectorCalls
    const walksBefore = stats.treeWalkerCalls

    const text = createTextNode('生成中')
    root.appendChild(text)
    mutate([{ type: 'childList', addedNodes: [text], removedNodes: [] }])

    const queries = stats.querySelectorCalls - queriesBefore
    assert.ok(queries <= 8, `expected at most 8 selector queries, saw ${queries}`)
    assert.equal(stats.treeWalkerCalls, walksBefore)
  })
})
