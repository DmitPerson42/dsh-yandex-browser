// One line per repository: last commit date, commit count, license and whether
// the repository is private — read from the repository home page.
//
//   node test/github-summary.mjs Ljy-0827/Director Ljy-0827/leetcode
const repos = process.argv.slice(2)

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

for (const repo of repos) {
  await call('Page.navigate', { url: `https://github.com/${repo}` })
  await wait(5500)
  const info = JSON.parse(await evaluate(`(() => {
    const text = document.body ? document.body.innerText : ''
    const times = [...document.querySelectorAll('relative-time')].map(t => t.getAttribute('datetime') || '')
    const commits = (text.match(/([\\d,]+)\\s+Commits?/) || [])[1] || (text.match(/([\\d,]+)\\s+commits?/) || [])[1] || ''
    const branch = (text.match(/\\b(\\d+)\\s+branches?\\b/i) || [])[1] || ''
    const tags = (text.match(/\\b(\\d+)\\s+tags?\\b/i) || [])[1] || ''
    return JSON.stringify({
      lastCommit: times[0] ? times[0].slice(0, 10) : '',
      created: times.length > 1 ? times[1].slice(0, 10) : '',
      commits,
      branch,
      tags,
      private: /^Private$/m.test(text),
      license: (text.match(/\\b(MIT|Apache-2\\.0|GPL-3\\.0|BSD[\\w-]*|MPL-2\\.0|Unlicense)\\b/) || [])[1] || '',
      contributors: (text.match(/(\\d+)\\s+Contributors?/) || [])[1] || '',
      issues: (document.getElementById('issues-repo-tab-count') || {}).innerText || '',
      hasReadme: /#readme/.test(document.documentElement.innerHTML)
    })
  })()`) ?? '{}')
  console.log(`${repo.padEnd(44)} коммитов: ${(info.commits || '?').padEnd(5)} последний: ${info.lastCommit || '?'}  ${info.private ? 'private' : 'public'}  лицензия: ${info.license || '—'}  issues: ${info.issues || '—'}`)
}

socket.close()
await fetch(`${live.origin}/json/close/${created.id}`).catch(() => {})
