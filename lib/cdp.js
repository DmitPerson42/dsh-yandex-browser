/**
 * @module dsh-yandex-browser/cdp
 *
 * Low-level Chrome DevTools Protocol client for the agent browser.
 *
 * Everything here talks to the debugging endpoint the plugin opened: the HTTP
 * half (`/json/version`, `/json/list`, `/json/new`, `/json/close`) for
 * discovery and tab bookkeeping, and one short-lived WebSocket per page for
 * the protocol calls themselves (`Page.navigate`, `Runtime.evaluate`,
 * `Input.dispatchMouseEvent`, `Page.captureScreenshot`).
 *
 * Sessions are deliberately stateless. Each page operation opens a socket,
 * runs the calls it needs, and closes it. A long-lived session would have to
 * track frame trees, target lifetimes and detach races; the short-lived form
 * cannot leak a half-open socket and recovers on its own from a tab that was
 * closed or navigated mid-call.
 *
 * Every session starts by bringing the tab to the front. That is not cosmetic:
 * Chromium freezes background tabs, and a frozen renderer answers no
 * `Runtime.evaluate` at all - it looks exactly like a dead page, which is what
 * a Google Drive tab in the background used to look like.
 *
 * Dependency-free: loaded from a file URL outside the dsh package tree, so
 * Node built-ins only.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * One JSON request against the DevTools HTTP endpoint.
 * @param {string} endpoint - DevTools origin, e.g. `http://127.0.0.1:9222`.
 * @param {string} pathname - endpoint path, e.g. `/json/version`.
 * @param {{method?: string, timeoutMs?: number}} [options] - request options.
 * @returns {Promise<any>} parsed JSON body, or `null` when the browser is unreachable.
 */
export async function cdpRequest(endpoint, pathname, options = {}) {
  const { method = 'GET', timeoutMs = 3000 } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${endpoint}${pathname}`, { method, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Origins to probe for the DevTools endpoint, in order. Chromium binds the
 * debugging socket to localhost, and on Windows that can land on either
 * 127.0.0.1 or [::1] depending on the machine's stack. The two are not
 * interchangeable: a server listening on [::1] is invisible to a request to
 * 127.0.0.1, which is why a plain IPv4 probe intermittently reports "not
 * running" on a browser that is very much running.
 * @param {string} endpoint - configured endpoint.
 * @returns {string[]} candidate origins, the configured one first.
 */
export function candidateOrigins(endpoint) {
  const origins = [endpoint]
  let url
  try {
    url = new URL(endpoint)
  } catch {
    return origins
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  if (host === '127.0.0.1' || host === 'localhost') {
    origins.push(`${url.protocol}//[::1]:${port}`)
  } else if (host === '::1') {
    origins.push(`${url.protocol}//127.0.0.1:${port}`)
  }
  return origins
}

/**
 * Find the first candidate origin that answers `/json/version`.
 * @param {string[]} candidates - candidate origins.
 * @returns {Promise<{origin: string, version: Record<string, any>}|null>} the live origin with its payload.
 */
export async function probe(candidates) {
  for (const origin of candidates) {
    const version = await cdpRequest(origin, '/json/version')
    if (version) return { origin, version }
  }
  return null
}

/**
 * Probe the configured endpoint across both loopback stacks.
 * @param {string} endpoint - configured endpoint.
 * @returns {Promise<{origin: string, version: Record<string, any>}|null>} the live origin, or `null`.
 */
export function probeEndpoint(endpoint) {
  return probe(candidateOrigins(endpoint))
}

/**
 * Poll the DevTools endpoint until the browser answers or the budget runs out.
 * A cold profile on its very first launch can take well over twenty seconds.
 * @param {string} endpoint - configured endpoint.
 * @param {number} timeoutMs - total wait budget.
 * @returns {Promise<{origin: string, version: Record<string, any>}|null>} the live origin, or `null`.
 */
export async function waitForBrowser(endpoint, timeoutMs) {
  const candidates = candidateOrigins(endpoint)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = await probe(candidates)
    if (hit) return hit
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return null
}

/**
 * List open page targets, dropping service workers and other background types.
 * @param {string} endpoint - DevTools origin.
 * @returns {Promise<{id: string, title: string, url: string, webSocketDebuggerUrl: string}[]>} open tabs.
 */
export async function listTabs(endpoint) {
  const targets = await cdpRequest(endpoint, '/json/list')
  if (!Array.isArray(targets)) return []
  return targets
    .filter((target) => target.type === 'page')
    .map((target) => ({
      id: String(target.id),
      title: String(target.title ?? ''),
      url: String(target.url ?? ''),
      webSocketDebuggerUrl: String(target.webSocketDebuggerUrl ?? ''),
    }))
}

/**
 * Ask the browser to close a tab. The endpoint answers with plain text
 * (`Target is closing`), so this cannot go through `cdpRequest`, which parses
 * JSON and would report every close as a failure.
 * @param {string} endpoint - DevTools origin.
 * @param {string} id - target id from `/json/list`.
 * @returns {Promise<boolean>} whether the browser accepted the request.
 */
export async function closeTab(endpoint, id) {
  return commandTab(endpoint, 'close', id)
}

/**
 * Bring a tab to the front, so the user sees it and the page is not frozen.
 * Like `/json/close`, this answers with plain text (`Target activated`).
 * @param {string} endpoint - DevTools origin.
 * @param {string} id - target id from `/json/list`.
 * @returns {Promise<boolean>} whether the browser accepted the request.
 */
export async function activateTab(endpoint, id) {
  return commandTab(endpoint, 'activate', id)
}

/**
 * One plain-text DevTools command on a target. Kept separate from
 * `cdpRequest` because `/json/close` and `/json/activate` answer with text, and
 * a JSON parser would turn a success into a failure.
 * @param {string} endpoint - DevTools origin.
 * @param {'close'|'activate'} command - which command to send.
 * @param {string} id - target id.
 * @returns {Promise<boolean>} whether the browser accepted the request.
 */
async function commandTab(endpoint, command, id) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const response = await fetch(`${endpoint}/json/${command}/${id}`, { method: 'PUT', signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Open a new tab, activate it, and optionally load a URL in it.
 *
 * `/json/new` is always asked for `about:blank`: this browser build ignores the
 * `?url=` parameter, so a requested URL is applied afterwards with a real
 * `Page.navigate` and the load is awaited. Doing it that way also means the
 * caller gets a target whose socket is already usable.
 * @param {string} endpoint - DevTools origin.
 * @param {string} [url] - URL to load in the new tab.
 * @param {number} [loadTimeoutMs] - how long to wait for the load event.
 * @returns {Promise<{id: string, title: string, url: string, webSocketDebuggerUrl: string}|null>} the created target, or `null`.
 */
export async function openTab(endpoint, url, loadTimeoutMs = 30000) {
  const query = new URLSearchParams({ url: 'about:blank' }).toString()
  const created = await cdpRequest(endpoint, `/json/new?${query}`, { method: 'PUT' })
    ?? await cdpRequest(endpoint, `/json/new?${query}`, { method: 'GET' })
  if (!created?.id) return null
  const target = {
    id: String(created.id),
    title: String(created.title ?? ''),
    url: String(created.url ?? 'about:blank'),
    webSocketDebuggerUrl: String(created.webSocketDebuggerUrl ?? ''),
  }
  await activateTab(endpoint, target.id)
  if (!url) return target
  try {
    await withPage(target, async (call) => {
      await call('Page.enable')
      await call('Page.navigate', { url })
      await waitForLoad(call, loadTimeoutMs)
    }, loadTimeoutMs)
    return { ...target, url }
  } catch {
    // The tab exists either way; a page that never finishes loading is the
    // caller's problem to inspect, not a reason to throw away the target.
    return target
  }
}

/**
 * Wait until the document of the current navigation stops loading.
 *
 * The socket carries one event per load state, so the waiter only has to watch
 * for the terminal one. A page that never gets there must not hang the tool,
 * hence the deadline.
 * @param {(method: string, params?: Record<string, any>) => Promise<any>} call - CDP call function.
 * @param {number} timeoutMs - how long to wait for `load`.
 * @returns {Promise<{loaded: boolean, href: string}>} whether the load finished, and the resulting address.
 */
export async function waitForLoad(call, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await evaluateJson(call, 'JSON.stringify({ ready: document.readyState, href: location.href })', { timeoutMs: 5000 })
      .catch(() => null)
    if (state?.ready === 'complete') return { loaded: true, href: String(state.href ?? '') }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  const state = await evaluateJson(call, 'JSON.stringify({ ready: document.readyState, href: location.href })', { timeoutMs: 5000 })
    .catch(() => null)
  return { loaded: false, href: String(state?.href ?? '') }
}

/**
 * Open a short-lived CDP session on one tab and hand a `call` function to the
 * caller. The socket is closed no matter how the callback ends.
 * @param {{webSocketDebuggerUrl: string, id?: string, url?: string}} target - page target from `/json/list`.
 * @param {(call: (method: string, params?: Record<string, any>) => Promise<any>) => Promise<any>} fn - session body.
 * @param {number} [timeoutMs] - per-call budget.
 * @returns {Promise<any>} whatever `fn` returns.
 */
export async function withPage(target, fn, timeoutMs = 20000) {
  const socketUrl = target?.webSocketDebuggerUrl
  if (!socketUrl) throw new Error('The tab has no debugging socket. It may have just been closed; run action "tabs" and pick another one.')
  const socket = new WebSocket(socketUrl)
  const pending = new Map()
  let nextId = 1
  const onMessage = (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    const entry = message.id !== undefined ? pending.get(message.id) : undefined
    if (!entry) return
    pending.delete(message.id)
    entry.resolve(message)
  }
  socket.addEventListener('message', onMessage)
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The debugging socket of the tab did not open within ${timeoutMs} ms.`)), timeoutMs)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('Could not attach to the debugging socket of the tab. Close the tab or restart the browser.'))
      }, { once: true })
    })
    const call = (method, params = {}, callTimeoutMs = timeoutMs) => new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP ${method} did not answer within ${callTimeoutMs} ms. The tab is probably busy; retry or reload it.`))
      }, callTimeoutMs)
      pending.set(id, {
        resolve: (message) => { clearTimeout(timer); resolve(message) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      socket.send(JSON.stringify({ id, method, params }))
    })
    // Unfreeze first, then enable the domains the session needs. Both are
    // best-effort: a tab that is already visible answers instantly, and a
    // browser that dislikes either command must not fail the whole operation.
    await call('Page.bringToFront', {}, 5000).catch(() => {})
    await call('Page.enable', {}, 5000).catch(() => {})
    return await fn(call)
  } finally {
    socket.removeEventListener('message', onMessage)
    try {
      socket.close()
    } catch {
      // The socket is already gone; nothing to clean up.
    }
  }
}

/**
 * Evaluate an expression in the page and return its value.
 * @param {(method: string, params?: Record<string, any>) => Promise<any>} call - CDP call function.
 * @param {string} expression - JavaScript source evaluated in the page.
 * @param {{awaitPromise?: boolean, timeoutMs?: number}} [options] - evaluation options.
 * @returns {Promise<any>} the value, or `undefined` when the page returned nothing.
 */
export async function evaluate(call, expression, options = {}) {
  const { awaitPromise = true, timeoutMs = 20000 } = options
  const answer = await call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    timeout: timeoutMs,
  })
  if (answer.error) throw new Error(`CDP error: ${answer.error.message ?? JSON.stringify(answer.error)}`)
  const details = answer.result?.exceptionDetails
  if (details) {
    const text = details.exception?.description ?? details.text ?? 'unknown page error'
    throw new Error(`The page threw: ${String(text).split('\n')[0]}`)
  }
  return answer.result?.result?.value
}

/**
 * Evaluate an expression that returns a JSON string and parse it.
 * @param {(method: string, params?: Record<string, any>) => Promise<any>} call - CDP call function.
 * @param {string} expression - JavaScript source returning a JSON string.
 * @param {{timeoutMs?: number}} [options] - evaluation options.
 * @returns {Promise<any>} the parsed value, or `null` when the page returned nothing usable.
 */
export async function evaluateJson(call, expression, options = {}) {
  const raw = await evaluate(call, expression, options)
  if (typeof raw !== 'string') return raw ?? null
  try {
    return JSON.parse(raw)
  } catch {
    return { raw: raw.slice(0, 2000) }
  }
}

/**
 * In-page script: page identity, visible text and the interactive elements on
 * screen. Google Drive and several other apps render rows and buttons with
 * empty `innerText`, so the element list reads `aria-label`, `title` and
 * placeholder - that is what makes a web-component UI readable from here.
 * @param {number} maxChars - character budget for the text body.
 * @param {number} maxElements - how many interactive elements to report.
 * @returns {string} a JavaScript expression that evaluates to a JSON string.
 */
export function pageProbeScript(maxChars, maxElements) {
  return `(async () => {
    const clip = (value, limit) => {
      const text = String(value ?? '').split('\\n').map((line) => line.replace(/\\s+/g, ' ').trim()).filter(Boolean).join('\\n')
      return text.length > limit ? text.slice(0, limit) + '\\n…' : text
    }
    const nodes = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input, textarea, select, [onclick]'))
    const elements = []
    const seen = new Set()
    for (const element of nodes) {
      const rect = element.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) continue
      const raw = element.getAttribute('aria-label')
        || element.getAttribute('title')
        || element.getAttribute('placeholder')
        || (element.tagName === 'INPUT' ? element.value : element.innerText)
        || ''
      const label = String(raw).split('\\n')[0].replace(/\\s+/g, ' ').trim().slice(0, 80)
      if (!label) continue
      const key = label + '|' + element.tagName
      if (seen.has(key)) continue
      seen.add(key)
      elements.push({ tag: element.tagName.toLowerCase(), role: element.getAttribute('role') || '', label })
      if (elements.length >= ${maxElements}) break
    }
    return JSON.stringify({
      href: location.href,
      title: document.title,
      ready: document.readyState,
      scroll: { y: Math.round(window.scrollY), height: document.documentElement.scrollHeight },
      text: clip(document.body ? document.body.innerText : '', ${maxChars}),
      textLength: (document.body ? document.body.innerText : '').length,
      elements,
    })
  })()`
}

/**
 * Pick the tab an operation should run on.
 *
 * `selector` accepts, in order of preference: an exact target id, the 1-based
 * position in the tab list, or a case-insensitive substring of the title or
 * URL. With nothing given, the currently active target wins; the browser
 * exposes it as the first entry of `/json/list`.
 * @param {{id: string, title: string, url: string, webSocketDebuggerUrl: string}[]} tabs - open tabs.
 * @param {string} [selector] - id, position, or substring.
 * @returns {{id: string, title: string, url: string, webSocketDebuggerUrl: string}} the chosen tab.
 */
export function pickTab(tabs, selector) {
  if (!tabs.length) throw new Error('The browser has no open tabs. Use yandex_act with action "navigate" first.')
  if (!selector) return tabs[0]
  const needle = String(selector).trim()
  const exact = tabs.find((tab) => tab.id === needle)
  if (exact) return exact
  const position = Number(needle)
  if (Number.isInteger(position) && position >= 1 && position <= tabs.length) return tabs[position - 1]
  const lowered = needle.toLowerCase()
  const partial = tabs.find((tab) => tab.title.toLowerCase().includes(lowered) || tab.url.toLowerCase().includes(lowered))
  if (partial) return partial
  const known = tabs.map((tab, index) => `${index + 1}. ${tab.title || tab.url}`).join('; ')
  throw new Error(`No tab matches "${needle}". Open tabs: ${known}`)
}

/**
 * Read the list of tabs this plugin opened, so it can close them again.
 * @param {string} file - state file path.
 * @returns {Set<string>} remembered target ids.
 */
export function loadTabLog(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return new Set(Array.isArray(parsed?.tabs) ? parsed.tabs.map(String) : [])
  } catch {
    return new Set()
  }
}

/**
 * Persist the list of tabs this plugin opened.
 * @param {string} file - state file path.
 * @param {Set<string>} tabs - target ids worth remembering.
 * @returns {void}
 */
export function saveTabLog(file, tabs) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ updated: new Date().toISOString(), tabs: [...tabs] }, null, 2))
  } catch (error) {
    console.warn(`[dsh-yandex-browser] could not save the tab log: ${error?.message ?? error}`)
  }
}