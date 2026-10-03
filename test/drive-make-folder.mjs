// Creates a folder in Google Drive and verifies that it appeared in the list.
//
//   node test/drive-make-folder.mjs "учёба"
//
// Drive's own shortcut Shift+N opens the new-folder input, which is far more
// reliable than clicking its custom menu components: synthetic .click() is
// ignored, and raw mouse events only hover. The mouse path is kept as a
// fallback in case the shortcut is rebound.

const folderName = process.argv[2] ?? 'учёба'
const DRIVE = 'https://drive.google.com/drive/my-drive'
const SHIFT = 8

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
const evaluate = async (expression) => {
  const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return response.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const key = async (params) => {
  await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}
/** True when the rename input is on screen, i.e. a folder is being named. */
const namingPromptOpen = () => evaluate(`!!document.querySelector('input[aria-label*="апк"], input[placeholder*="апк"], [role="dialog"] input, input[jsname="GgtwHf"]')`)

await new Promise((resolve) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', resolve)
})
await call('Page.enable')
await call('Runtime.enable')
await call('Page.navigate', { url: DRIVE })
await wait(8000)

console.log(`Создаю папку «${folderName}»…`)

// The menu path is the one that works: Shift+N never reaches Drive's handler in
// this build, and a synthetic .click() is ignored outright. Only real mouse
// events at the control's centre open the menu.
async function press(text, scope = '') {
  const raw = await evaluate(`(() => {
    const wanted = ${JSON.stringify(text)}
    const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : 'document'}
    if (!root) return ''
    const node = [...root.querySelectorAll('div, span, button, [role="button"], [role="menuitem"]')]
      .find(n => n.offsetParent !== null && (n.innerText || '').trim() === wanted)
    if (!node) return ''
    const box = node.getBoundingClientRect()
    if (box.width < 4 || box.height < 4) return ''
    return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
  })()`)
  if (!raw) return false
  const { x, y } = JSON.parse(raw)
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  return true
}

if (!await press('Создать')) console.log('  кнопка «Создать» не найдена')
await wait(1800)
if (!await press('Новая папка')) console.log('  пункт «Новая папка» не найден')
await wait(2500)

// Drive focuses its inline name input itself; the only job here is to make sure
// the text lands there rather than in an unrelated hidden field.
const focusedTag = await evaluate(`(() => {
  const active = document.activeElement
  return active ? active.tagName + '|' + (active.getAttribute('aria-label') || active.className || '').slice(0, 60) : 'нет'
})()`)
console.log('  фокус:', focusedTag)
await call('Input.insertText', { text: folderName })
await wait(1000)
const typed = await evaluate(`(() => {
  const active = document.activeElement
  return active && 'value' in active ? active.value : ''
})()`)
console.log(`  введено: "${typed}"`)

// Enter confirms Drive's inline input; the dialog button is the backup.
await key({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
await wait(3500)
if (!(await evaluate(`document.body.innerText.includes(${JSON.stringify(folderName)})`))) {
  await press('Создать', '[role="dialog"]')
  await wait(3000)
}

// Match a whole line: a row tooltip also carries type words like "Папка", and
// filtering those out once hid a folder that had in fact been created.
const names = JSON.parse(await evaluate(`JSON.stringify(
  (document.body.innerText || '').split('\\n').map(t => t.trim()).filter(Boolean)
)`) ?? '[]')
const exists = names.includes(folderName)
console.log('\n--- содержимое «Моего диска» ---')
for (const name of names.filter((t) => !/^(я|Создать|Помеченные|Только что|Рядом)$/i.test(t)).slice(0, 40)) {
  console.log('  •', name)
}
console.log(exists ? `\nПапка «${folderName}» создана.` : `\nПапка «${folderName}» в списке не появилась.`)

if (!exists) {
  const shot = await call('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync('_drive_after.png', Buffer.from(shot.result.data, 'base64'))
    console.log('скриншот: _drive_after.png')
  }
}

socket.close()
await fetch(`${live.origin}/json/close/${created.id}`).catch(() => {})
