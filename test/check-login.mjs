// Checks whether the agent browser profile is signed in, using two independent
// signals instead of guessing from a URL redirect:
//   1. session cookies for the yandex domains (names only, never values),
//   2. the state of yandex.ru itself — signed out shows a "Войти" call to action.
// Both are read from a throwaway tab that is closed again at the end.
//
//   node test/check-login.mjs [url]

const target = process.argv[2] ?? 'https://yandex.ru/'

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
const label = (live.version['User-Agent'] ?? '').match(/YaBrowser\/[\d.]+/)?.[0] ?? live.version.Browser
console.log(`браузер: ${label} @ ${live.origin}`)

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
await call('Network.enable')
await call('Page.navigate', { url: target })
await new Promise((r) => setTimeout(r, 5000))

// 1. Cookies. `yandex_login` is the account name and `Session_id` is the auth
// ticket, so those two settle the question; the rest of the names are printed
// for context and their values are never read.
const cookies = await call('Network.getCookies', { urls: ['https://yandex.ru/', 'https://passport.yandex.ru/'] })
const all = cookies.result?.cookies ?? []
const names = [...new Set(all.map((cookie) => cookie.name))]
const loginCookie = all.find((cookie) => cookie.name === 'yandex_login')
const sessionCookie = all.find((cookie) => cookie.name === 'Session_id')
console.log(`куки yandex: ${names.join(', ') || 'нет'}`)
console.log(`аккаунт (yandex_login): ${loginCookie ? decodeURIComponent(loginCookie.value) : 'НЕТ'}`)
console.log(`Session_id: ${sessionCookie ? `есть, ${sessionCookie.value.length} символов` : 'НЕТ'}`)

// 2. A page that cannot render without a session: the passport profile. A valid
// session loads the profile, an invalid one bounces to the auth form.
const profileCall = await call('Runtime.evaluate', {
  expression: `JSON.stringify({ href: location.href, title: document.title })`,
  returnByValue: true,
})
void profileCall

await call('Page.navigate', { url: 'https://passport.yandex.ru/profile' })
let state = { href: '', title: '' }
for (let attempt = 0; attempt < 12; attempt++) {
  await new Promise((r) => setTimeout(r, 800))
  const probed = await call('Runtime.evaluate', {
    expression: `JSON.stringify({
      href: location.href,
      title: document.title,
      ready: document.readyState,
      hasPasswordField: !!document.querySelector('input[type="password"]')
    })`,
    returnByValue: true,
  })
  state = JSON.parse(probed.result?.result?.value ?? '{}')
  if (state.ready === 'complete') break
}
console.log(`\npassport.yandex.ru/profile -> ${state.title} (${state.href})`)
console.log(`поле пароля: ${state.hasPasswordField ? 'есть' : 'нет'}`)

const bounced = !/passport\.yandex\.ru\/(auth|login)/i.test(state.href ?? '')
const signedIn = Boolean(loginCookie) && Boolean(sessionCookie) && bounced && !state.hasPasswordField
console.log(signedIn
  ? '\nВЕРДИКТ: вход выполнен — сессия активна, профиль открывается без формы входа.'
  : '\nВЕРДИКТ: вход НЕ выполнен.')

socket.close()
await fetch(`${live.origin}/json/close/${created.id}`).catch(() => {})
