// Opens a page in the agent browser, prints what it says, and can save a
// screenshot. Run it against any signed-in page.
//
//   node test/page-dump.mjs https://plus.yandex.ru/
//   node test/page-dump.mjs https://plus.yandex.ru/ --shot plus.png --chars 4000

const url = process.argv[2] ?? 'https://yandex.ru/'
const shotIndex = process.argv.indexOf('--shot')
const charsIndex = process.argv.indexOf('--chars')
const shotPath = shotIndex >= 0 ? process.argv[shotIndex + 1] : null
const maxChars = charsIndex >= 0 ? Number(process.argv[charsIndex + 1]) : 3000

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
  console.log('Браузер агента не запущен.')
  process.exit(1)
}

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
await call('Emulation.setDeviceMetricsOverride', {
  width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
})
await call('Page.navigate', { url })

// Wait until the document is complete, then give client-side rendering a moment.
let state = {}
for (let attempt = 0; attempt < 20; attempt++) {
  await new Promise((r) => setTimeout(r, 700))
  const probed = await call('Runtime.evaluate', {
    expression: `JSON.stringify({
      href: location.href,
      title: document.title,
      ready: document.readyState,
      text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim()
    })`,
    returnByValue: true,
  })
  state = JSON.parse(probed.result?.result?.value ?? '{}')
  if (state.ready === 'complete' && (state.text?.length ?? 0) > 200) break
}

console.log(`адрес:  ${state.href}`)
console.log(`заголовок: ${state.title}`)
console.log(`статус: ${state.ready}, текста ${state.text?.length ?? 0} символов`)
console.log('\n--- текст страницы ---')
console.log((state.text ?? '').slice(0, maxChars))

if (shotPath) {
  const shot = await call('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'))
    console.log(`\nскриншот сохранён: ${shotPath}`)
  }
}

socket.close()
await fetch(`${live.origin}/json/close/${created.id}`).catch(() => {})
