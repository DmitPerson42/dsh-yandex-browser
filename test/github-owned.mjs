// Lists the repositories of the account that the browser session is signed in
// to, using the account settings page, which is authoritative about ownership.
//
//   node test/github-owned.mjs
const origin = 'http://localhost:9222'

const created = await (await fetch(`${origin}/json/new?about=blank`, { method: 'PUT' })).json()
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

for (const url of ['https://github.com/settings/profile', 'https://github.com/settings/repositories']) {
  await call('Page.navigate', { url })
  await wait(7000)
  const state = JSON.parse(await evaluate(`(() => {
    const text = document.body ? document.body.innerText : ''
    const repos = [...document.querySelectorAll('a[href^="/"][href$="/"]')]
      .map(a => a.getAttribute('href').slice(1))
      .filter(p => p.split('/').length === 2)
    return JSON.stringify({
      href: location.href,
      title: document.title,
      head: text.slice(0, 500),
      count: (text.match(/(\\d+)\\s+repositor/i) || [])[1] || '',
      repos: [...new Set(repos)]
    })
  })()`) ?? '{}')
  console.log(`\n=== ${url} ===`)
  console.log(`заголовок: ${state.title}`)
  console.log(`счётчик в тексте: ${state.count || '—'}`)
  if (state.repos?.length) console.log(`репозитории: ${state.repos.join(', ')}`)
  console.log(`начало страницы:\n${(state.head || '').slice(0, 300)}`)
}

socket.close()
await fetch(`${origin}/json/close/${created.id}`).catch(() => {})
