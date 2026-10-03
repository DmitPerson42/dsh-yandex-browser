// Smoke test: loads the plugin the way the dsh loader does (file URL import),
// registers it into a stub ctx.tools, and runs the lifecycle actions.
//
//   node test/smoke.mjs            — status only, never launches a browser
//   node test/smoke.mjs --launch   — also starts the browser and opens a tab
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = pathToFileURL(path.join(HERE, '..', 'lib', 'index.js')).href

const mod = await import(ENTRY)
console.log('exports:', Object.keys(mod).sort().join(', '))
if (mod.name !== 'yandex-browser') throw new Error('bad plugin name')
if (!Array.isArray(mod.inject) || !mod.inject.includes('tools')) throw new Error('missing tools injection')
if (typeof mod.apply !== 'function') throw new Error('missing apply')
if ('default' in mod) throw new Error('a default export would drop `inject` at load time')

let tool = null
const ctx = { tools: { register: (t) => { tool = t } } }
mod.apply(ctx, {})
if (!tool) throw new Error('tool was not registered')
console.log('tool:', tool.name)
console.log('actions:', tool.parameters.properties.action.enum.join(', '))

async function call(args) {
  const value = await tool.execute(args)
  for (const block of tool.output.render(args, value)) {
    if (block.type === 'text') console.log(`\n=== ${args.action} ===\n${block.text}`)
  }
  return value
}

await call({ action: 'status' })

if (process.argv.includes('--launch')) {
  await call({ action: 'start' })
  await call({ action: 'open', url: 'https://ya.ru' })
  await call({ action: 'tabs' })
}
