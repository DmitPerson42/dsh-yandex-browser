// Opens a URL in a tab of the agent browser and leaves that tab open, so the user
// can sign in, solve a captcha, or confirm something by hand. Everything the
// other test scripts do happens in a throwaway tab; this one is the opposite.
//
//   node test/open-tab.mjs https://accounts.google.com/ [waitSeconds]

const url = process.argv[2] ?? 'https://accounts.google.com/'
const waitSeconds = Number(process.argv[3] ?? 10)

async function connect() {
  for (const origin of ['http://localhost:9222', 'http://127.0.0.1:9222', 'http://[::1]:9222']) {
    try {
      const response = await fetch(`${origin}/json/version`, { signal: AbortSignal.timeout(3000) })
      return { origin, version: await response.json() }
    } catch {
      // try the next candidate
    }
  }
  return null
}

const live = await connect()
if (!live) {
  console.log('Браузер агента не запущен. Вызови yandex_browser с action "start".')
  process.exit(1)
}

// /json/new ignores its ?url= parameter in this browser build, so create a blank
// target and navigate it over CDP.
const created = await (
  await fetch(`${live.origin}/json/new?${new URLSearchParams({ url: 'about:blank' })}`, { method: 'PUT' })
).json()

const socket = new WebSocket(created.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
})
const call = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params }))
})
await new Promise((resolve) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', resolve)
})
await call('Page.enable')
await call('Page.navigate', { url })

for (let waited = 0; waited < waitSeconds; waited += 5) {
  await new Promise((r) => setTimeout(r, 5000))
  const probed = await call('Runtime.evaluate', {
    expression: `JSON.stringify({ href: location.href, title: document.title })`,
    returnByValue: true,
  })
  const state = JSON.parse(probed.result?.result?.value ?? '{}')
  if (state.href && state.href !== 'about:blank') {
    console.log(`через ${waited + 5}с: ${state.title} — ${state.href}`)
    break
  }
  console.log(`через ${waited + 5}с: загружается…`)
}

socket.close()
console.log('вкладка оставлена открытой — введите логин и пароль в окне браузера')
