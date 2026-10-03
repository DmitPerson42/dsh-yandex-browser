// Walks every repository of the signed-in user and reports what is inside:
// description, language split, stars, last commit, topics and README excerpt.
//
//   node test/github-repo-details.mjs Ljy-0827/Director Ljy-0827/leetcode
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
const created = await (await fetch(`${live.origin}/json/new?about=blank`, { method: 'PUT' })).json()
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
  await wait(6000)
  const info = JSON.parse(await evaluate(`(() => {
    const text = document.body ? document.body.innerText : ''
    const description = (document.querySelector('meta[name="description"]') || {}).content || ''
    const topics = [...document.querySelectorAll('a.topic-tag')].map(a => a.innerText.trim())
    const languages = [...document.querySelectorAll('a[href*="/search?l="], .Progress-item .Progress-item-label')]
      .map(n => n.innerText.trim().replace(/\\s+/g, ' ')).filter(Boolean)
    const counters = {}
    for (const [key, id] of [['stars', 'repo-stars-counter-star'], ['forks', 'repo-network-counter'], ['watchers', 'repo-notifications-counter']]) {
      const node = document.getElementById(id)
      if (node) counters[key] = node.innerText.trim()
    }
    const commit = document.querySelector('[data-testid="latest-commit-details"]')
    const commitLink = document.querySelector('.react-last-commit-message a, [data-testid="latest-commit-details"] a')
    const readme = document.querySelector('#readme article, article.markdown-body')
    const files = [...document.querySelectorAll('table[aria-labelledby="folders-and-files"] tbody tr td:nth-child(1) a, tbody tr.react-directory-row td div a')]
      .map(a => a.innerText.trim()).filter(Boolean).slice(0, 25)
    return JSON.stringify({
      title: document.title,
      description: description.split(' · ')[0],
      topics,
      languages: [...new Set(languages)].slice(0, 8),
      counters,
      commit: commit ? commit.innerText.replace(/\\n/g, ' ').trim().slice(0, 120) : '',
      commitTitle: commitLink ? commitLink.innerText.trim().slice(0, 100) : '',
      readme: readme ? readme.innerText.replace(/\\n{2,}/g, '\\n').trim().slice(0, 500) : '',
      files: [...new Set(files)]
    })
  })()`) ?? '{}')

  console.log(`\n=== ${repo} ===`)
  console.log(`описание: ${info.description || '—'}`)
  console.log(`языки: ${info.languages?.join(', ') || '—'}`)
  console.log(`звёзды/форки/наблюдатели: ${[info.counters?.stars, info.counters?.forks, info.counters?.watchers].filter(Boolean).join(' / ') || '—'}`)
  if (info.topics?.length) console.log(`темы: ${info.topics.join(', ')}`)
  if (info.commitTitle || info.commit) console.log(`последний коммит: ${info.commitTitle} — ${info.commit}`)
  if (info.files?.length) console.log(`файлы: ${info.files.join(', ')}`)
  if (info.readme) console.log(`README:\n${info.readme}`)
  else console.log('README: нет')
}

socket.close()
await fetch(`${live.origin}/json/close/${created.id}`).catch(() => {})
