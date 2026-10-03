// Gracefully closes Yandex Browser instances started on the given CDP ports.
//   node test/close-test-browsers.mjs 9222 9333

/** Whether the DevTools endpoint on `port` still answers. */
async function alive(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

for (const port of process.argv.slice(2)) {
  if (!await alive(port)) {
    console.log(`порт ${port}: закрыт`)
    continue
  }

  const response = await fetch(`http://127.0.0.1:${port}/json/version`)
  const info = await response.json()
  const label = (info['User-Agent'] ?? '').match(/YaBrowser\/[\d.]+/)?.[0] ?? info.Browser

  // Browser.close makes the process quit, which kills the socket before it can
  // send a close frame — so confirm by polling the endpoint instead.
  try {
    const socket = new WebSocket(info.webSocketDebuggerUrl)
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000)
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  } catch {
    // The socket dying is itself the expected outcome here.
  }

  let closed = false
  for (let attempt = 0; attempt < 10 && !closed; attempt++) {
    await new Promise((r) => setTimeout(r, 300))
    closed = !(await alive(port))
  }
  console.log(`порт ${port}: ${label} — ${closed ? 'закрыт' : 'не удалось закрыть'}`)
}
