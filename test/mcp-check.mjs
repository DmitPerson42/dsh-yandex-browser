// End-to-end check of the browser hand-off: starts @playwright/mcp against the
// already-running Yandex Browser DevTools endpoint and lists the tools the
// agent would receive. Run it with the browser up (yandex_browser action=start).
//
//   node test/mcp-check.mjs [cdp-endpoint]
import { spawn } from 'node:child_process'

const endpoint = process.argv[2] ?? process.env.YANDEX_CDP ?? 'http://127.0.0.1:9222'
const child = spawn('npx', ['-y', '@playwright/mcp@latest', '--cdp-endpoint', endpoint], {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true,
})

let buffer = ''
const pending = new Map()
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      console.log('[non-json]', line)
      continue
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
})
child.stderr.on('data', (chunk) => process.stderr.write(`[mcp] ${chunk}`))

let nextId = 1
function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolve(message)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dsh-yandex-browser-probe', version: '1.0.0' },
  })
  console.log('server:', JSON.stringify(init.result?.serverInfo ?? init.error))
  notify('notifications/initialized')

  const tools = await request('tools/list', {})
  const names = (tools.result?.tools ?? []).map((tool) => tool.name)
  console.log(`endpoint: ${endpoint}`)
  console.log(`tools (${names.length}): ${names.join(', ')}`)

  const snapshot = await request('tools/call', { name: 'browser_tabs', arguments: { action: 'list' } })
  const text = (snapshot.result?.content ?? []).map((block) => block.text ?? '').join('\n')
  console.log('browser_tabs:', text.slice(0, 400))
} catch (error) {
  console.error('FAILED:', error.message)
  process.exitCode = 1
} finally {
  child.kill()
}
