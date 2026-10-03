// Reports recent commit history with real dates for the given repositories, and
// the listing of a directory inside a repository.
//
//   node test/github-commits.mjs Ljy-0827/Director Ljy-0827/depression-detection-system
//   node test/github-commits.mjs --tree Ljy-0827/depression-detection-system/system-front-end
const argTree = process.argv.indexOf('--tree')
const tree = argTree >= 0 ? process.argv[argTree + 1] : ''
const repos = process.argv.slice(2).filter((a) => a !== '--tree' && a !== tree)

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
const goto = async (url) => {
  await call('Page.navigate', { url })
  await wait(6000)
}

await new Promise((resolve) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', resolve)
})
await call('Page.enable')
await call('Runtime.enable')

if (tree) {
  await goto(`https://github.com/${tree}`)
  const listing = JSON.parse(await evaluate(`JSON.stringify(
    [...document.querySelectorAll('table[aria-labelledby="folders-and-files"] tbody tr, tbody tr.react-directory-row')]
      .map(row => {
        const cells = [...row.querySelectorAll('td')].map(c => c.innerText.trim())
        const message = row.querySelector('a[aria-label*="View commit details"]')
        return { name: cells[0] || '', message: message ? message.getAttribute('aria-label').replace('View commit details\\n', '') : '' }
      })
  `) ?? '[]')
  console.log(`=== ${tree} ===`)
  for (const row of listing) console.log(`  ${row.name}${row.message ? '   — ' + row.message : ''}`)
}

for (const repo of repos) {
  await goto(`https://github.com/${repo}/commits`)
  const commits = JSON.parse(await evaluate(`JSON.stringify(
    [...document.querySelectorAll('li.Box-row, .react-directory-commit-row')].map(row => {
      const message = row.querySelector('a.Link--primary, .Link--primary') || row.querySelector('a')
      const time = row.querySelector('relative-time')
      return {
        message: message ? message.innerText.trim().slice(0, 90) : '',
        when: time ? time.getAttribute('datetime') : '',
        sha: (row.querySelector('a[href*="/commit/"]')?.getAttribute('href') || '').split('/').pop()
      }
    }).filter(c => c.message)
  `) ?? '[]')
  console.log(`\n=== ${repo} — последние коммиты (${commits.length}) ===`)
  for (const commit of commits) console.log(`  ${commit.when.slice(0, 10)}  ${commit.sha?.slice(0, 7)}  ${commit.message}`)
}

socket.close()
await fetch(`${live.origin}/json/close/${created.id}`).catch(() => {})
