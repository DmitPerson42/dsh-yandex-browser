/**
 * @module dsh-yandex-browser
 *
 * Runs Yandex Browser as a CDP-controlled agent profile and gives the model
 * direct tools for the pages inside it.
 *
 * The plugin owns browser *lifecycle*: locate the executable, launch it with a
 * persistent `--user-data-dir` plus a debugging port, wait until the DevTools
 * endpoint answers, and report the state. `yandex_page` and `yandex_act` add the
 * page layer on top of that same endpoint, so navigation, reading, clicking and
 * typing keep working even when the Playwright MCP client cannot attach - which
 * it intermittently could not.
 *
 * The profile directory is a stable, dedicated folder, never a temp directory:
 * whatever the user signs into once there (Yandex Passport, Google, GitHub, ...)
 * stays signed in for every later launch, which is the whole point of running
 * the agent against a real profile instead of a throwaway session.
 *
 * Dependency-free on purpose - it is loaded by file URL from outside the dsh
 * package tree, so it may only use Node built-ins.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import {
  activateTab,
  candidateOrigins,
  cdpRequest,
  closeTab,
  evaluate,
  evaluateJson,
  listTabs,
  loadTabLog,
  openTab,
  pageProbeScript,
  pickTab,
  probe,
  probeEndpoint,
  saveTabLog,
  waitForBrowser,
  waitForLoad,
  withPage,
} from './cdp.js'

/** Loader entry name; also the id prefix used in the composition file. */
const name = 'yandex-browser'

/** Registrants this plugin needs from the composition. */
const inject = ['tools']

/** Model-facing tool names. */
const BROWSER_TOOL = 'yandex_browser'
const PAGE_TOOL = 'yandex_page'
const ACT_TOOL = 'yandex_act'

/** Default DevTools endpoint; the MCP client in this profile uses the same one. */
const DEFAULT_ENDPOINT = 'http://localhost:9222'

/** Where the agent profile lives. Stable across launches, so logins persist. */
const DEFAULT_PROFILE_DIR = path.join(homedir(), '.dsh', 'browsers', 'yandex')

/** Where screenshots go when the caller does not name a file. */
const DEFAULT_SHOTS_DIR = path.join(homedir(), '.dsh', 'browser-shots')

/** Install locations, most specific first; `YANDEX_BROWSER_PATH` wins. */
const CANDIDATE_EXECUTABLES = [
  'C:\\Program Files\\Yandex\\YandexBrowser\\Application\\browser.exe',
  'C:\\Program Files (x86)\\Yandex\\YandexBrowser\\Application\\browser.exe',
  path.join(homedir(), 'AppData', 'Local', 'Yandex', 'YandexBrowser', 'Application', 'browser.exe'),
  path.join(homedir(), 'AppData', 'Local', 'Yandex', 'YandexBrowserBeta', 'Application', 'browser.exe'),
]

/** Landing page for the `login` action: the user's own Yandex account. */
const DEFAULT_LOGIN_URL = 'https://passport.yandex.ru/auth?retpath=https://yandex.ru/'

/** Flags that keep an automated first launch quiet and unobtrusive. */
const LAUNCH_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
  '--no-service-autorun',
  '--disable-infobars',
]

/** Keys the `key` action can send, with the fields CDP needs for a real keystroke. */
const KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
}

/**
 * Merge the composition config with the environment. Explicit config wins, then
 * the same env vars the MCP client reads, then the built-in defaults - so
 * changing `YANDEX_CDP` moves the MCP client and this plugin together.
 * @param {Record<string, unknown>} [config] - entry config from the composition.
 * @returns {{executable: string|null, endpoint: string, profileDir: string, port: number, autoStart: boolean, screenshotDir: string, tabStateFile: string}} resolved settings.
 */
function resolveSettings(config) {
  const cfg = config ?? {}
  const endpoint = String(cfg.cdpEndpoint ?? process.env.YANDEX_CDP ?? DEFAULT_ENDPOINT).replace(/\/+$/, '')
  const profileDir = String(cfg.profileDir ?? process.env.YANDEX_BROWSER_PROFILE ?? DEFAULT_PROFILE_DIR)
  const executable = String(cfg.executable ?? process.env.YANDEX_BROWSER_PATH ?? findExecutable() ?? '') || null
  let port = Number(cfg.port ?? process.env.YANDEX_BROWSER_PORT ?? new URL(endpoint).port)
  if (!Number.isInteger(port) || port <= 0) port = 9222
  // The MCP client connects once at startup and retries a bounded number of
  // times, so the browser has to be up before it gives up. Auto-start is what
  // makes that ordering work without the user thinking about it.
  const autoStart = cfg.autoStart ?? process.env.YANDEX_BROWSER_AUTOSTART !== '0'
  return {
    executable,
    endpoint,
    profileDir,
    port,
    autoStart: autoStart !== false,
    screenshotDir: String(cfg.screenshotDir ?? DEFAULT_SHOTS_DIR),
    tabStateFile: String(cfg.tabStateFile ?? path.join(profileDir, 'agent-tabs.json')),
  }
}

/**
 * First existing Yandex Browser binary, or `null` when Yandex is not installed.
 * @returns {string|null} absolute path to the executable.
 */
function findExecutable() {
  for (const candidate of CANDIDATE_EXECUTABLES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Human-readable description of what the profile folder already holds. Logins
 * cannot be read (they are encrypted), so this reports file-level evidence only.
 * @param {string} profileDir - agent profile directory.
 * @returns {{exists: boolean, hasCookies: boolean, hasPreferences: boolean, sizeMb: number|null}} profile state.
 */
function readProfileState(profileDir) {
  const state = { exists: false, hasCookies: false, hasPreferences: false, sizeMb: 0 }
  if (!existsSync(profileDir)) return state
  state.exists = true
  state.hasCookies = existsSync(path.join(profileDir, 'Default', 'Cookies'))
    || existsSync(path.join(profileDir, 'Default', 'Network', 'Cookies'))
  state.hasPreferences = existsSync(path.join(profileDir, 'Default', 'Preferences'))
  try {
    state.sizeMb = Math.round(statSync(profileDir).size / 1e6 * 10) / 10
  } catch {
    state.sizeMb = 0
  }
  return state
}

/**
 * Ask the browser to exit through its browser-level WebSocket, then wait for
 * the endpoint to stop answering. The socket dies together with the process,
 * so a close-frame event is not a reliable signal - the endpoint is.
 * @param {string} endpoint - live DevTools origin.
 * @param {number} [timeoutMs] - how long to wait for the port to go away.
 * @returns {Promise<boolean>} whether the browser stopped serving the endpoint.
 */
async function closeBrowser(endpoint, timeoutMs = 5000) {
  if (typeof WebSocket !== 'function') return false
  const version = await cdpRequest(endpoint, '/json/version')
  const socketUrl = version?.webSocketDebuggerUrl
  if (!socketUrl) return false
  try {
    const socket = new WebSocket(socketUrl)
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000)
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  } catch {
    // The socket disappearing is the expected outcome, not a failure.
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdpRequest(endpoint, '/json/version') === null) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

/**
 * Whether a DevTools endpoint belongs to Yandex Browser. Yandex keeps a
 * Chromium base and reports `Chrome/<version>` in the `Browser` field, so the
 * branding only shows up in the User-Agent as `YaBrowser/<version>`.
 * @param {{Browser?: string, 'User-Agent'?: string}} version - `/json/version` payload.
 * @returns {boolean} true when the endpoint is a Yandex Browser instance.
 */
function isYandex(version) {
  const haystack = `${version?.Browser ?? ''} ${version?.['User-Agent'] ?? ''}`.toLowerCase()
  return haystack.includes('yabrowser') || haystack.includes('yandex')
}

/**
 * One-line identification of the browser serving an endpoint.
 * @param {{Browser?: string, 'User-Agent'?: string}} version - `/json/version` payload.
 * @returns {string} a human-readable name.
 */
function describeBrowser(version) {
  const ua = String(version?.['User-Agent'] ?? '')
  const branded = ua.match(/YaBrowser\/[\d.]+/)
  const chromium = String(version?.Browser ?? 'unknown browser')
  return branded ? `Yandex Browser ${branded[0].split('/')[1]} (${chromium})` : chromium
}

/**
 * Resolve the live endpoint or explain how to get one.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @returns {Promise<{origin: string, version: Record<string, any>}>} the live origin.
 */
async function requireBrowser(settings) {
  const hit = await probeEndpoint(settings.endpoint)
  if (!hit) {
    throw new Error(
      `Браузер агента не запущен: ${settings.endpoint} не отвечает. `
      + `Вызови ${BROWSER_TOOL} с action "start" и повтори.`,
    )
  }
  return hit
}

/* -------------------------------------------------------------------------- */
/* Tab bookkeeping                                                            */
/* -------------------------------------------------------------------------- */

/** Target ids this plugin opened, kept across restarts so it can close them. */
let createdTabs = new Set()

/**
 * Point the bookkeeping at the configured state file and drop remembered ids
 * that no longer exist - the user closed those tabs by hand.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @returns {void}
 */
function initTabLog(settings) {
  createdTabs = loadTabLog(settings.tabStateFile)
  probeEndpoint(settings.endpoint)
    .then((hit) => (hit ? listTabs(hit.origin) : []))
    .then((tabs) => {
      const alive = new Set(tabs.map((tab) => tab.id))
      const kept = new Set([...createdTabs].filter((id) => alive.has(id)))
      if (kept.size !== createdTabs.size) saveTabLog(settings.tabStateFile, kept)
      createdTabs = kept
    })
    .catch(() => { /* the browser is simply not running yet */ })
}

/**
 * Remember a tab the plugin opened.
 * @param {string} id - target id.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @returns {void}
 */
function rememberTab(id, settings) {
  createdTabs.add(id)
  saveTabLog(settings.tabStateFile, createdTabs)
}

/**
 * Forget a tab that is gone.
 * @param {string} id - target id.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @returns {void}
 */
function forgetTab(id, settings) {
  if (!createdTabs.delete(id)) return
  saveTabLog(settings.tabStateFile, createdTabs)
}

/* -------------------------------------------------------------------------- */
/* In-page scripts                                                             */
/* -------------------------------------------------------------------------- */

/**
 * In-page script that resolves an element from a CSS selector or from visible
 * text, scrolls it into view, and reports the viewport coordinates of its
 * centre. Clicking goes through `Input.dispatchMouseEvent` at those coordinates
 * rather than `element.click()`, because several apps ignore synthetic clicks
 * that never went through the browser's input pipeline.
 * @param {{selector?: string, text?: string}} spec - what to look for.
 * @returns {string} a JavaScript expression that evaluates to a JSON string.
 */
function locateScript(spec) {
  const payload = JSON.stringify({ selector: spec.selector ?? '', text: spec.text ?? '' })
  return `(async () => {
    const spec = ${payload}
    const label = (element) => String(
      element.innerText
      || element.getAttribute('aria-label')
      || element.getAttribute('title')
      || element.getAttribute('placeholder')
      || element.value
      || element.getAttribute('name')
      || '',
    ).split('\\n')[0].replace(/\\s+/g, ' ').trim().slice(0, 80)
    let element = null
    if (spec.selector) element = document.querySelector(spec.selector)
    if (!element && spec.text) {
      const needle = spec.text.toLowerCase()
      const all = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], label, input, textarea, select, li, td, div, span'))
      const exact = all.filter((candidate) => label(candidate).toLowerCase() === needle)
      const partial = exact.length ? exact : all.filter((candidate) => label(candidate).toLowerCase().includes(needle))
      // The deepest match is the real control: a click on an ancestor usually
      // lands on a wrapper that has no handler of its own.
      element = partial.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_CONTAINS ? 1 : -1))[0] ?? null
    }
    if (!element) return JSON.stringify({ found: false })
    element.scrollIntoView({ block: 'center', inline: 'center' })
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const rect = element.getBoundingClientRect()
    return JSON.stringify({
      found: true,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || '',
      label: label(element),
      disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    })
  })()`
}

/**
 * In-page script that focuses a field and clears it, so the following insertText
 * does not append to whatever was there. React tracks the previous value on the
 * DOM node, so the value has to be replaced through the native setter.
 * @param {string} selector - CSS selector of the field.
 * @returns {string} a JavaScript expression that evaluates to a JSON string.
 */
function focusScript(selector) {
  const payload = JSON.stringify({ selector })
  return `(async () => {
    const element = document.querySelector(${payload}.selector)
    if (!element) return JSON.stringify({ found: false })
    if (element.isContentEditable) {
      element.focus()
      element.textContent = ''
    } else {
      element.focus()
      const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')?.set
      if (setter) setter.call(element, '')
      else if ('value' in element) element.value = ''
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return JSON.stringify({ found: true, tag: element.tagName.toLowerCase() })
  })()`
}

/**
 * Write a base64 PNG from CDP to disk.
 * @param {string} file - destination path; its directory must exist.
 * @param {string} data - base64 payload.
 * @returns {void}
 */
function writeShot(file, data) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, Buffer.from(data, 'base64'))
}

/* -------------------------------------------------------------------------- */
/* yandex_page                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Base fields every `yandex_page` answer carries.
 * @param {string} action - the action that ran.
 * @param {{id?: string, title?: string, url?: string}} tab - the tab it ran on.
 * @param {string} message - human-readable summary.
 * @returns {Record<string, unknown>} the base payload.
 */
function pageResult(action, tab, message) {
  return {
    action,
    tabId: tab?.id ?? '',
    tabTitle: tab?.title ?? '',
    tabUrl: tab?.url ?? '',
    href: '',
    ready: '',
    text: '',
    textLength: 0,
    scrollHeight: 0,
    elements: [],
    value: '',
    file: '',
    bytes: 0,
    tabs: [],
    message,
  }
}

/**
 * Read a page: its text, its interactive elements, an arbitrary expression, or
 * a screenshot file.
 * @param {Record<string, any>} args - validated tool arguments.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @returns {Promise<Record<string, unknown>>} the model-facing payload.
 */
async function runPage(args, settings) {
  const { origin } = await requireBrowser(settings)
  const timeoutMs = Number(args.timeoutMs ?? 20000)

  if (args.action === 'tabs') {
    const tabs = await listTabs(origin)
    const known = new Set(tabs.map((tab) => tab.id))
    const pruned = new Set([...createdTabs].filter((id) => known.has(id)))
    if (pruned.size !== createdTabs.size) saveTabLog(settings.tabStateFile, pruned)
    createdTabs = pruned
    return {
      ...pageResult('tabs', {}, `Открыто вкладок: ${tabs.length}. Создано этим плагином: ${createdTabs.size}.`),
      tabs: tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url, mine: createdTabs.has(tab.id) })),
    }
  }

  const tabs = await listTabs(origin)
  const tab = pickTab(tabs, args.tab)

  if (args.action === 'text') {
    const state = await withPage(
      tab,
      (call) => evaluateJson(call, pageProbeScript(Number(args.maxChars ?? 6000), Number(args.maxElements ?? 60))),
      timeoutMs,
    )
    return {
      ...pageResult(
        'text',
        tab,
        `${state?.ready ?? '?'} · текста ${state?.textLength ?? 0} символов · элементов ${state?.elements?.length ?? 0}`,
      ),
      href: String(state?.href ?? tab.url),
      ready: String(state?.ready ?? ''),
      text: String(state?.text ?? ''),
      textLength: Number(state?.textLength ?? 0),
      scrollHeight: Number(state?.scroll?.height ?? 0),
      elements: Array.isArray(state?.elements) ? state.elements : [],
    }
  }

  if (args.action === 'eval') {
    if (!args.expression) throw new Error('Для action "eval" нужен параметр `expression`.')
    const value = await withPage(tab, (call) => evaluate(call, args.expression), timeoutMs)
    const serialized = value === undefined ? '' : (typeof value === 'string' ? value : JSON.stringify(value ?? null))
    return {
      ...pageResult('eval', tab, serialized ? `Выражение вернуло ${serialized.length} симв.` : 'Выражение вернуло пустое значение.'),
      value: serialized.slice(0, 20000),
    }
  }

  // action === 'screenshot'
  const shot = await withPage(tab, async (call) => {
    const params = { format: 'png' }
    if (args.fullPage) {
      const metrics = await call('Page.getLayoutMetrics')
      const size = metrics.result?.cssContentSize ?? metrics.result?.contentSize
      if (size?.height) {
        params.captureBeyondViewport = true
        params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 }
      }
    }
    return call('Page.captureScreenshot', params)
  }, timeoutMs)
  const data = shot?.result?.data
  if (!data) throw new Error('Браузер не вернул изображение. Попробуй ещё раз или уменьши страницу.')
  const bytes = Math.round(data.length * 0.75)
  if (args.file) {
    writeShot(path.resolve(args.file), data)
    return { ...pageResult('screenshot', tab, `Скриншот сохранён: ${path.resolve(args.file)}`), file: path.resolve(args.file), bytes }
  }
  // The configured directory is outside the workspace, so it can be unwritable
  // when the plugin runs under a file sandbox (test scripts do). Falling back to
  // a temp folder keeps the tool working instead of failing on a mkdir.
  for (const directory of [settings.screenshotDir, path.join(tmpdir(), 'dsh-browser-shots')]) {
    try {
      mkdirSync(directory, { recursive: true })
      const file = path.join(directory, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
      writeShot(file, data)
      const fallback = directory === settings.screenshotDir ? '' : ` (каталог ${settings.screenshotDir} недоступен, записано во временный)`
      return { ...pageResult('screenshot', tab, `Скриншот сохранён: ${file}${fallback}`), file, bytes }
    } catch (error) {
      if (directory === settings.screenshotDir) continue
      throw new Error(`Не удалось сохранить скриншот: ${error?.message ?? error}`)
    }
  }
  throw new Error(`Не удалось создать каталог для скриншота: ${settings.screenshotDir}`)
}

/* -------------------------------------------------------------------------- */
/* yandex_act                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Base fields every `yandex_act` answer carries.
 * @param {string} action - the action that ran.
 * @param {{id?: string, title?: string, url?: string}} tab - the tab it ran on.
 * @param {string} message - human-readable summary.
 * @returns {Record<string, unknown>} the base payload.
 */
function actResult(action, tab, message) {
  return {
    action,
    tabId: tab?.id ?? '',
    tabTitle: tab?.title ?? '',
    tabUrl: tab?.url ?? '',
    created: false,
    loaded: false,
    found: false,
    matched: '',
    value: '',
    closed: [],
    message,
  }
}

/**
 * Act on a page: navigate, click, type, press a key, manage tabs.
 * @param {Record<string, any>} args - validated tool arguments.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @returns {Promise<Record<string, unknown>>} the model-facing payload.
 */
async function runAct(args, settings) {
  const { origin } = await requireBrowser(settings)
  const timeoutMs = Number(args.timeoutMs ?? 20000)

  if (args.action === 'close_created') {
    const tabs = await listTabs(origin)
    const alive = new Map(tabs.map((tab) => [tab.id, tab]))
    const closed = []
    for (const id of [...createdTabs]) {
      const tab = alive.get(id)
      if (tab) {
        if (await closeTab(origin, id)) closed.push({ id, title: tab.title, url: tab.url })
      }
      forgetTab(id, settings)
    }
    return {
      ...actResult('close_created', {}, `Закрыто вкладок, созданных плагином: ${closed.length}`),
      closed,
    }
  }

  if (args.action === 'navigate') {
    if (!args.url) throw new Error('Для action "navigate" нужен параметр `url`.')
    if (args.newTab) {
      const created = await openTab(origin, args.url, timeoutMs)
      if (!created) throw new Error('Браузер отказался открывать вкладку.')
      rememberTab(created.id, settings)
      return {
        ...actResult('navigate', created, `Открыт ${args.url} в новой вкладке. Закрой её через action "close" или "close_created", когда работа закончится.`),
        created: true,
        loaded: created.url !== 'about:blank',
      }
    }
    const tab = pickTab(await listTabs(origin), args.tab)
    const loaded = await withPage(tab, async (call) => {
      await call('Page.enable')
      await call('Page.navigate', { url: args.url })
      return waitForLoad(call, timeoutMs)
    }, timeoutMs)
    return {
      ...actResult('navigate', { ...tab, url: loaded.href || args.url }, `Переход на ${args.url}${loaded.loaded ? '' : ' (страница не дошла до complete)'}`),
      loaded: loaded.loaded,
    }
  }

  const tab = pickTab(await listTabs(origin), args.tab)

  if (args.action === 'activate') {
    const activated = await activateTab(origin, tab.id)
    return {
      ...actResult('activate', tab, activated ? `Вкладка активирована: ${tab.title || tab.url}` : 'Браузер не принял запрос активации вкладки.'),
    }
  }

  if (args.action === 'close') {
    const closed = await closeTab(origin, tab.id)
    forgetTab(tab.id, settings)
    return {
      ...actResult('close', tab, closed ? `Вкладка закрыта: ${tab.title || tab.url}` : 'Браузер не принял запрос закрытия вкладки.'),
    }
  }

  if (args.action === 'wait') {
    const deadline = Date.now() + timeoutMs
    const spec = { selector: args.selector ?? '', text: args.text ?? '' }
    let found = false
    let matched = ''
    while (Date.now() < deadline) {
      const hit = await withPage(tab, (call) => evaluateJson(call, locateScript(spec), { timeoutMs: 5000 }))
        .catch(() => null)
      if (hit?.found) {
        found = true
        matched = hit.label
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return {
      ...actResult('wait', tab, found
        ? `Появилось: ${matched}`
        : `За ${timeoutMs} мс не появилось. Страница могла не загрузиться - проверь её через ${PAGE_TOOL} action "text".`),
      found,
      matched,
    }
  }

  if (args.action === 'key') {
    const descriptor = KEYS[String(args.key ?? 'enter').toLowerCase()]
    if (!descriptor) throw new Error(`Клавиша "${args.key}" не поддерживается. Доступны: ${Object.keys(KEYS).join(', ')}.`)
    const send = (type, extra = {}) => ({
      type,
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode,
      ...extra,
    })
    await withPage(tab, async (call) => {
      await call('Input.dispatchKeyEvent', send('keyDown', descriptor.text ? { text: descriptor.text } : {}))
      await call('Input.dispatchKeyEvent', send('keyUp'))
    }, timeoutMs)
    return { ...actResult('key', tab, `Клавиша ${descriptor.key} отправлена в: ${tab.title || tab.url}`) }
  }

  if (!args.selector && !args.text) {
    throw new Error(`Для action "${args.action}" нужен \`selector\` (CSS) или \`text\` (видимый текст элемента).`)
  }

  const spec = { selector: args.selector ?? '', text: args.text ?? '' }
  const found = await withPage(tab, (call) => evaluateJson(call, locateScript(spec)), timeoutMs)
  if (!found?.found) {
    throw new Error(spec.selector
      ? `Селектор ${spec.selector} ничего не нашёл. Проверь его через ${PAGE_TOOL} action "text" - там видны подписи элементов.`
      : `Текст "${spec.text}" не найден на странице. Вызови ${PAGE_TOOL} action "text" и посмотри список элементов.`)
  }

  if (args.action === 'click') {
    if (found.disabled) throw new Error(`Элемент "${found.label}" неактивен (disabled). Страница, вероятно, ещё грузится.`)
    await withPage(tab, async (call) => {
      const common = { x: found.x, y: found.y, button: 'left', clickCount: 1 }
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...common })
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...common })
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common })
    }, timeoutMs)
    return {
      ...actResult('click', tab, `Клик по <${found.tag}> «${found.label}»`),
      found: true,
      matched: found.label,
    }
  }

  // action === 'type'
  await withPage(tab, (call) => evaluateJson(call, focusScript(args.selector), { timeoutMs }), timeoutMs)
  await withPage(tab, (call) => call('Input.insertText', { text: String(args.value ?? '') }), timeoutMs)
  if (args.submit) {
    const enter = KEYS.enter
    await withPage(tab, async (call) => {
      await call('Input.dispatchKeyEvent', { type: 'keyDown', key: enter.key, code: enter.code, windowsVirtualKeyCode: enter.keyCode, text: '\r' })
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: enter.key, code: enter.code, windowsVirtualKeyCode: enter.keyCode })
    }, timeoutMs)
  }
  const value = await withPage(
    tab,
    (call) => evaluate(call, `document.querySelector(${JSON.stringify(args.selector)})?.value ?? ''`),
    timeoutMs,
  )
  return {
    ...actResult('type', tab, `Введено в <${found.tag}> «${found.label}»${args.submit ? ' и отправлено' : ''}`),
    found: true,
    matched: found.label,
    value: String(value ?? '').slice(0, 200),
  }
}

/* -------------------------------------------------------------------------- */
/* yandex_browser (lifecycle)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build the shared result object every lifecycle action returns.
 * @param {Record<string, unknown>} extra - action-specific fields.
 * @returns {Record<string, unknown>} the model-facing payload.
 */
function result(extra) {
  return {
    action: 'status',
    running: false,
    endpoint: '',
    executable: '',
    profileDir: '',
    browser: '',
    tabs: [],
    profile: { exists: false, hasCookies: false, hasPreferences: false, sizeMb: 0 },
    message: '',
    ...extra,
  }
}

/** JSON Schema for one tab, shared by the parameters and the output. */
const TAB_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'url'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    url: { type: 'string' },
    mine: { type: 'boolean' },
  },
}

/**
 * Run one lifecycle action against the browser.
 * @param {Record<string, any>} args - validated tool arguments.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @returns {Promise<Record<string, unknown>>} the model-facing payload.
 */
async function run(args, settings) {
  const { executable, endpoint, profileDir, port } = settings
  const action = args.action
  const hit = await probe(candidateOrigins(endpoint))
  const version = hit?.version ?? null
  const live = hit?.origin ?? endpoint
  const running = version !== null
  const base = result({ endpoint: live, executable: executable ?? '', profileDir, profile: readProfileState(profileDir) })

  if (!executable && action !== 'status') {
    throw new Error(
      'Yandex Browser is not installed. Set YANDEX_BROWSER_PATH or the `executable` config field to browser.exe.',
    )
  }

  // A live endpoint owned by a different browser means the port is taken.
  if (running && !isYandex(version)) {
    return {
      ...base,
      action,
      running: true,
      browser: describeBrowser(version),
      message:
        `Port ${port} is already served by ${describeBrowser(version)}. `
        + 'Close that browser, or point both this plugin and the MCP client at another port.',
    }
  }

  if (action === 'close') {
    const closed = await closeBrowser(live)
    return {
      ...base,
      action,
      running: !closed,
      browser: running ? describeBrowser(version) : '',
      message: closed
        ? 'Browser is closing. Saved logins stay in the profile and are reused on the next start.'
        : 'The browser did not accept the close command; close the window manually.',
    }
  }

  let launched = false
  if (!running && (action === 'start' || action === 'open' || action === 'login')) {
    mkdirSync(profileDir, { recursive: true })
    const startUrl = action === 'login' ? (args.url ?? DEFAULT_LOGIN_URL) : args.url
    const child = spawn(
      executable,
      [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, ...LAUNCH_FLAGS, ...(startUrl ? [startUrl] : [])],
      { detached: true, stdio: 'ignore' },
    )
    child.unref()
    launched = true
    const ready = await waitForBrowser(endpoint, args.timeoutMs ?? 60000)
    if (!ready) {
      throw new Error(
        `Yandex Browser did not open a DevTools endpoint on ${endpoint} within the timeout. `
        + 'A user-data-dir outside the default profile is mandatory on recent Chromium builds, '
        + 'and the very first launch of a cold profile can take a minute.',
      )
    }
    return {
      ...base,
      endpoint: ready.origin,
      action,
      running: true,
      browser: describeBrowser(ready.version),
      profile: readProfileState(profileDir),
      tabs: (await listTabs(ready.origin)).map(({ id, title, url }) => ({ id, title, url })),
      message: messageFor(action, true),
    }
  }

  if (action === 'start') {
    return {
      ...base,
      action,
      running,
      browser: running ? describeBrowser(version) : '',
      tabs: running ? (await listTabs(live)).map(({ id, title, url }) => ({ id, title, url })) : [],
      message: running ? 'Browser was already running.' : 'Nothing to start: no executable resolved.',
    }
  }

  if (action === 'open' || action === 'login') {
    const url = action === 'login' ? (args.url ?? DEFAULT_LOGIN_URL) : args.url
    if (!url) throw new Error(`\`${action}\` requires a \`url\` argument.`)
    const created = await openTab(live, url, Number(args.timeoutMs ?? 30000))
    if (!created) throw new Error(`Could not open ${url}: the browser refused to create a tab.`)
    rememberTab(created.id, settings)
    return {
      ...base,
      action,
      running: true,
      browser: describeBrowser(version),
      tabs: (await listTabs(live)).map(({ id, title, url }) => ({ id, title, url })),
      message: messageFor(action, false, url),
    }
  }

  // `status` and `tabs`.
  return {
    ...base,
    action,
    running,
    browser: running ? describeBrowser(version) : '',
    tabs: running ? (await listTabs(live)).map(({ id, title, url }) => ({ id, title, url })) : [],
    message: running
      ? `Browser is running and reachable at ${live}; the ${PAGE_TOOL} and ${ACT_TOOL} tools can drive it.`
      : 'Browser is not running. Call this tool with action "start" first.',
  }
}

/**
 * Action-specific guidance for the model and the user.
 * @param {string} action - the action that just ran.
 * @param {boolean} launched - whether this call started the browser.
 * @param {string} [url] - the URL that was opened, for `open` and `login`.
 * @returns {string} one message.
 */
function messageFor(action, launched, url) {
  const started = launched ? 'Browser started' : 'Browser already running'
  if (action === 'login') {
    return `${started}. The user must sign in by hand in that window; the session is stored in the agent profile and reused on every later start.`
  }
  if (action === 'open') return `${started}. Opened ${url}. The ${PAGE_TOOL} and ${ACT_TOOL} tools can now drive this page.`
  return `${started}. The ${PAGE_TOOL} and ${ACT_TOOL} tools can now drive the browser.`
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Register the three browser tools on `ctx.tools`.
 * @param {{tools: {register: (tool: unknown) => unknown}} ctx - registrant context.
 * @param {Record<string, unknown>} [config] - entry config from the composition.
 */
function apply(ctx, config) {
  const settings = resolveSettings(config)
  initTabLog(settings)

  ctx.tools.register({
    name: BROWSER_TOOL,
    description:
      'Start and supervise Yandex Browser for the agent, using a persistent profile so sites the user signs into once stay signed in. '
      + 'This tool owns lifecycle only: status, start, open a tab, open a login page, list tabs, close. '
      + `Page work is done with ${PAGE_TOOL} and ${ACT_TOOL}, and with the Playwright MCP tools when they are connected to the same port. `
      + `Typical flow: status -> start (or just open, which starts it) -> ${PAGE_TOOL} to read, ${ACT_TOOL} to act. `
      + 'Never type credentials yourself: for sign-in call action "login" and let the user enter the password in the visible window.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'start', 'open', 'login', 'tabs', 'close'],
          description: 'status = report state; start = launch if needed; open = open a URL (starts if needed); login = open a sign-in page for the user; tabs = list open tabs; close = quit the browser (logins persist).',
        },
        url: {
          type: 'string',
          description: 'Target URL for `open` and `login`. `login` defaults to the Yandex Passport page.',
        },
        timeoutMs: {
          type: 'number',
          description: 'How long `start` waits for the DevTools endpoint, in milliseconds. Default 60000; a cold profile needs more on its first launch.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'running', 'endpoint', 'profileDir', 'profile', 'tabs', 'message'],
        properties: {
          action: { type: 'string' },
          running: { type: 'boolean' },
          endpoint: { type: 'string' },
          executable: { type: 'string' },
          profileDir: { type: 'string' },
          browser: { type: 'string' },
          tabs: { type: 'array', items: TAB_SCHEMA },
          profile: {
            type: 'object',
            additionalProperties: false,
            required: ['exists', 'hasCookies', 'hasPreferences', 'sizeMb'],
            properties: {
              exists: { type: 'boolean' },
              hasCookies: { type: 'boolean' },
              hasPreferences: { type: 'boolean' },
              sizeMb: { type: 'number' },
            },
          },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        const lines = [`${value.message}`]
        if (value.browser) lines.push(`Browser: ${value.browser}`)
        lines.push(`Endpoint: ${value.endpoint}`)
        lines.push(`Profile: ${value.profileDir}${value.profile?.hasCookies ? ' (has stored sessions)' : ''}`)
        if (value.tabs?.length) {
          lines.push('Tabs:')
          for (const tab of value.tabs) lines.push(`  - ${tab.title || '(no title)'} - ${tab.url}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      return run(args, settings)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Yandex Browser: ${args.action}`,
      kind: 'other',
      rawInput: args,
    }),
  })

  ctx.tools.register({
    name: PAGE_TOOL,
    description:
      'Read a page in the agent browser over its debugging port: the visible text plus the interactive elements (buttons, links, fields) with their labels, the result of an arbitrary JavaScript expression, or a screenshot saved to a PNG file. '
      + 'Use it when you need to know what is on the page - especially when a page is built from web components whose text never reaches innerText, such as Google Drive: there the "elements" list is the only way to see the rows. '
      + `Feed those labels into ${ACT_TOOL} to click or type. `
      + `Start the browser first with ${BROWSER_TOOL} action "start".`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['text', 'eval', 'screenshot', 'tabs'],
          description: 'text = page text and interactive elements; eval = run JavaScript in the page; screenshot = save a PNG file; tabs = list open tabs with their ids.',
        },
        tab: {
          type: 'string',
          description: 'Which tab to read: exact id from action "tabs", 1-based position, or a substring of the title or URL. Default: the active tab.',
        },
        expression: {
          type: 'string',
          description: 'JavaScript evaluated in the page, for action "eval". Its value is returned as text.',
        },
        maxChars: {
          type: 'number',
          description: 'Character budget for the text body, action "text". Default 6000.',
        },
        maxElements: {
          type: 'number',
          description: 'How many interactive elements to report, action "text". Default 60.',
        },
        file: {
          type: 'string',
          description: 'Where to write the PNG, action "screenshot". Default: a timestamped file in the plugin screenshot directory.',
        },
        fullPage: {
          type: 'boolean',
          description: 'Capture the whole scrollable page instead of the viewport, action "screenshot".',
        },
        timeoutMs: {
          type: 'number',
          description: 'How long one page operation may take, in milliseconds. Default 20000.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'tabId', 'tabTitle', 'tabUrl', 'message'],
        properties: {
          action: { type: 'string' },
          tabId: { type: 'string' },
          tabTitle: { type: 'string' },
          tabUrl: { type: 'string' },
          href: { type: 'string' },
          ready: { type: 'string' },
          text: { type: 'string' },
          textLength: { type: 'number' },
          scrollHeight: { type: 'number' },
          elements: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['tag', 'role', 'label'],
              properties: {
                tag: { type: 'string' },
                role: { type: 'string' },
                label: { type: 'string' },
              },
            },
          },
          value: { type: 'string' },
          file: { type: 'string' },
          bytes: { type: 'number' },
          tabs: { type: 'array', items: TAB_SCHEMA },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        const lines = [`${value.message}`]
        if (value.href) lines.push(`Адрес: ${value.href}`)
        if (value.action === 'text') {
          if (value.elements?.length) {
            lines.push('Элементы:')
            for (const element of value.elements) {
              lines.push(`  [${element.tag}${element.role ? `/${element.role}` : ''}] ${element.label}`)
            }
          }
          if (value.text) lines.push(`\nТекст страницы:\n${value.text}`)
        }
        if (value.value) lines.push(value.value)
        if (value.file) lines.push(`Файл: ${value.file}`)
        if (value.tabs?.length) {
          lines.push('Вкладки:')
          for (const tab of value.tabs) lines.push(`  ${tab.mine ? '*' : ' '} ${tab.id.slice(0, 8)} ${tab.title || tab.url}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      return runPage(args, settings)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Yandex page: ${args.action}`,
      kind: 'other',
      rawInput: args,
    }),
  })

  ctx.tools.register({
    name: ACT_TOOL,
    description:
      'Act on a page in the agent browser: navigate, click an element found by CSS selector or by its visible text, type into a field, press a key, switch or close tabs. '
      + `Find elements first with ${PAGE_TOOL} action "text" - it returns exactly the labels that click and type accept. `
      + 'A tab created with newTab is remembered on disk, so action "close_created" closes every tab this plugin opened and leaves your own working tabs alone; prefer closing such a tab right after the work is done. '
      + 'Never type passwords, codes or card data yourself: open the sign-in page, stop, and let the user type it into the visible browser window. '
      + `Start the browser first with ${BROWSER_TOOL} action "start".`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'click', 'type', 'key', 'activate', 'close', 'close_created', 'wait'],
          description: 'navigate = load a URL; click = press an element; type = fill a field; key = press one key; activate = focus a tab; close = close one tab; close_created = close every tab this plugin opened; wait = wait for an element to appear.',
        },
        tab: {
          type: 'string',
          description: `Which tab: exact id from ${PAGE_TOOL} action "tabs", 1-based position, or a substring of the title or URL. Default: the active tab.`,
        },
        url: { type: 'string', description: 'Address to load, action "navigate".' },
        newTab: { type: 'boolean', description: 'Open the URL in a new tab instead of the current one, action "navigate". The new tab is remembered and can be closed by id or by action "close_created".' },
        selector: { type: 'string', description: 'CSS selector of the element, actions "click", "type" and "wait".' },
        text: { type: 'string', description: 'Visible text of the element to click or wait for, when a selector is not at hand. Actions "click" and "wait".' },
        value: { type: 'string', description: 'Text to type, action "type".' },
        key: { type: 'string', enum: Object.keys(KEYS), description: 'Key to press, action "key". Default: enter.' },
        submit: { type: 'boolean', description: 'Press Enter after typing, action "type".' },
        timeoutMs: { type: 'number', description: 'How long the action may take, in milliseconds. Default 20000.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'tabId', 'tabTitle', 'tabUrl', 'message'],
        properties: {
          action: { type: 'string' },
          tabId: { type: 'string' },
          tabTitle: { type: 'string' },
          tabUrl: { type: 'string' },
          created: { type: 'boolean' },
          loaded: { type: 'boolean' },
          found: { type: 'boolean' },
          matched: { type: 'string' },
          value: { type: 'string' },
          closed: { type: 'array', items: TAB_SCHEMA },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        const lines = [`${value.message}`]
        if (value.closed?.length) {
          lines.push('Закрыто:')
          for (const tab of value.closed) lines.push(`  - ${tab.title || tab.url}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      return runAct(args, settings)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Yandex act: ${args.action}`,
      kind: 'other',
      rawInput: args,
    }),
  })

  if (settings.autoStart) {
    // Fire and forget: a browser that fails to appear must never break the load
    // of the composition, and the `start` action can retry with a real error.
    run({ action: 'start' }, settings).catch((error) => {
      console.warn(`[dsh-yandex-browser] auto-start skipped: ${error?.message ?? error}`)
    })
  }
}

export { apply, inject, name }