// Lists the repositories of the signed-in GitHub user straight from the web UI,
// so both public and private repositories are visible.
//
//   node test/github-repos.mjs
const HOME = 'https://github.com/'

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
const created = await (await fetch(`${live.origin}/json/new?about:blank`, { method: 'PUT' })).json()
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
const evaluate = async (expression) => {
  const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return response.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await new Promise((resolve) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', resolve)
})
await call('Page.enable')
await call('Runtime.enable')
await call('Page.navigate', { url: HOME })
await wait(6000)

// The signed-in shell renders "Dashboard" without a literal /dashboard link, so
// detect the state from the header text and read the login from the avatar link.
let who = { signedIn: false, user: '' }
for (let attempt = 0; attempt < 8; attempt++) {
  who = JSON.parse(await evaluate(`(() => {
    const text = document.body ? document.body.innerText : ''
    const signedIn = /\\bDashboard\\b/.test(text) && !/^Sign in$/m.test(text)
    const avatar = document.querySelector('img[alt="Avatar"], img[alt="User avatar"]')
    const link = avatar ? avatar.closest('a') : document.querySelector('a[data-hovercard-type="user"]')
    // The avatar link can be absolute, so take the first path segment, not the raw href.
    let login = ''
    if (link) {
      const pathname = new URL(link.href || link.getAttribute('href'), location.origin).pathname
      login = pathname.split('/').filter(Boolean)[0] || ''
    }
    return JSON.stringify({ signedIn, user: login })
  })()`) ?? '{}')
  if (who.signedIn && who.user) break
  await wait(2000)
}

if (!who.signedIn) {
  console.log('GitHub: вход не выполнен.')
  socket.close()
  await fetch(`${live.origin}/json/close/${created.id}`).catch(() => {})
  process.exit(1)
}
const user = who.user
if (!user) {
  console.log('Не удалось определить логин из шапки GitHub.')
  socket.close()
  await fetch(`${live.origin}/json/close/${created.id}`).catch(() => {})
  process.exit(1)
}
console.log(`вошёл как: ${user}\n`)

await call('Page.navigate', { url: `https://github.com/${user}?tab=repositories` })
await wait(7000)

const repos = JSON.parse(await evaluate(`JSON.stringify(
  [...document.querySelectorAll('#user-repositories-list li')].map(li => {
    const link = li.querySelector('h3 a, h4 a')
    const lines = (li.innerText || '').split('\\n').map(t => t.trim()).filter(Boolean)
    return {
      name: link ? link.getAttribute('href').split('/').pop() : '',
      description: li.querySelector('p') ? li.querySelector('p').innerText.trim() : '',
      lines
    }
  })
)`) ?? '[]')

console.log(`репозиториев: ${repos.length}\n`)
for (const repo of repos) {
  console.log(`— ${repo.name}`)
  if (repo.description) console.log(`    ${repo.description}`)
  console.log(`    ${repo.lines.slice(1).join(' · ')}`)
  console.log('')
}

socket.close()
await fetch(`${live.origin}/json/close/${created.id}`).catch(() => {})
