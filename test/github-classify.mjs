// Classifies repositories: fork or original, archived or active, and the commit
// count, so a list of "my repositories" can be filtered to what really counts.
//
//   node test/github-classify.mjs Ljy-0827/Director Ljy-0827/leetcode
const repos = process.argv.slice(2)
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

for (const repo of repos) {
  await call('Page.navigate', { url: `https://github.com/${repo}` })
  await wait(5500)
  const info = JSON.parse(await evaluate(`(() => {
    const text = document.body ? document.body.innerText : ''
    const forkLine = (text.match(/forked from\\s*\\n?([^\\n]+)/i) || [])[1] || ''
    const archived = /This repository has been archived|archived by the owner/i.test(text)
    const isPrivate = /^Private$/m.test(text) || /This repository is private/i.test(text)
    const commits = (text.match(/([\\d,.k]+)\\s*[Cc]ommits?/) || [])[1] || ''
    const branches = (text.match(/([\\d,.k]+)\\s*branches?/i) || [])[1] || ''
    const tags = (text.match(/([\\d,.k]+)\\s*tags?/i) || [])[1] || ''
    const times = [...document.querySelectorAll('relative-time')].map(t => t.getAttribute('datetime') || '')
    const contributors = (text.match(/([\\d,.k]+)\\s*[Cc]ontributors?/) || [])[1] || ''
    const size = (text.match(/([\\d.,]+\\s*[kMGB]?B)\\s*\\n?\\n?\\s*(?:\\n|$)/) || [])[1] || ''
    return JSON.stringify({ forkLine, archived, isPrivate, commits, branches, tags, contributors, last: times[0] ? times[0].slice(0, 10) : '' })
  })()`) ?? '{}')
  const kind = info.forkLine ? `ФОРК от ${info.forkLine.trim()}` : 'оригинал'
  console.log(`${repo.padEnd(42)} ${kind.padEnd(28)} ${info.archived ? 'АРХИВ ' : 'активен'} ${info.isPrivate ? 'private' : 'public  '} коммитов: ${info.commits || '?'}  контрибьюторов: ${info.contributors || '?'}  последний: ${info.last}`)
}

socket.close()
await fetch(`${origin}/json/close/${created.id}`).catch(() => {})
