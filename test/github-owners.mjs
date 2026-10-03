// Lists the repositories shown on a profile tab together with their FULL owner
// path, so repositories that belong to an organisation are not mistaken for the
// user's own.
//
//   node test/github-owners.mjs Ljy-0827
const user = process.argv[2] ?? 'Ljy-0827'
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
await call('Page.navigate', { url: `https://github.com/${user}?tab=repositories` })
await wait(8000)

// The repositories tab carries an ownership filter; read it so the listing can
// be attributed unambiguously.
const filters = JSON.parse(await evaluate(`(() => {
  const controls = [...document.querySelectorAll('button, summary, [role="tab"]')]
    .map(n => (n.innerText || '').trim().replace(/\\n/g, ' '))
    .filter(t => t && t.length < 40)
  return JSON.stringify({
    controls: [...new Set(controls)].slice(0, 25),
    ownerFilter: [...new Set(controls)].find(t => /your repositories|organi/i.test(t)) || '',
    text: (document.body.innerText || '').slice(0, 400)
  })
})()`) ?? '{}')

const repos = JSON.parse(await evaluate(`JSON.stringify(
  [...document.querySelectorAll('#user-repositories-list li')].map(li => {
    const link = li.querySelector('h3 a, h4 a')
    const pathname = link ? new URL(link.href, location.origin).pathname : ''
    return {
      path: pathname.replace(/^\\//, ''),
      owner: pathname.split('/')[1] || '',
      name: pathname.split('/')[2] || '',
      description: li.querySelector('p') ? li.querySelector('p').innerText.trim() : '',
      meta: (li.innerText || '').split('\\n').map(t => t.trim()).filter(Boolean).slice(1, 4)
    }
  })
)`) ?? '[]')

console.log(`фильтры на странице: ${filters.ownerFilter || 'не найдено'}`)
console.log(`всего строк: ${repos.length}\n`)
for (const repo of repos) {
  const own = repo.owner === user ? 'СВОЙ     ' : `ОРГАНИЗАЦИЯ (${repo.owner})`
  console.log(`${own}  ${repo.path}`)
  if (repo.description) console.log(`          описание: ${repo.description}`)
}
const own = repos.filter((r) => r.owner === user)
console.log(`\nсвоих: ${own.length} — ${own.map((r) => r.name).join(', ')}`)
const foreign = repos.filter((r) => r.owner !== user)
console.log(`чужих (организации): ${foreign.length} — ${foreign.map((r) => r.path).join(', ')}`)

socket.close()
await fetch(`${origin}/json/close/${created.id}`).catch(() => {})
