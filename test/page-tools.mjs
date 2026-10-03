// Exercises the plugin's CDP helpers against the running agent browser:
// open a tab, read the page, evaluate an expression, screenshot, close.
//
//   node test/page-tools.mjs
//   node test/page-tools.mjs http://localhost:9222 https://example.com/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  evaluate,
  evaluateJson,
  listTabs,
  openTab,
  closeTab,
  pageProbeScript,
  probeEndpoint,
  withPage,
} from '../lib/cdp.js'

const endpoint = process.argv[2] ?? 'http://localhost:9222'
const url = process.argv[3] ?? 'https://example.com/'

const live = await probeEndpoint(endpoint)
if (!live) {
  console.log('Браузер агента не запущен. Вызови yandex_browser с action "start".')
  process.exit(1)
}
console.log(`эндпоинт: ${live.origin}`)

const before = await listTabs(live.origin)
console.log(`вкладок до прогона: ${before.length}`)

const tab = await openTab(live.origin, url)
if (!tab) {
  console.log('Браузер отказался открывать вкладку.')
  process.exit(1)
}
console.log(`открыта вкладка ${tab.id}`)

try {
  const state = await withPage(tab, (call) => evaluateJson(call, pageProbeScript(600, 12)))
  console.log('\n--- pageProbeScript ---')
  console.log(`адрес:   ${state?.href}`)
  console.log(`заголовок: ${state?.title}`)
  console.log(`состояние: ${state?.ready}, текста ${state?.textLength} символов, высота ${state?.scroll?.height}px`)
  console.log(`элементов: ${state?.elements?.length}`)
  for (const element of state?.elements ?? []) {
    console.log(`  [${element.tag}${element.role ? '/' + element.role : ''}] ${element.label}`)
  }
  console.log(`\nтекст: ${(state?.text ?? '').slice(0, 200).replace(/\n/g, ' | ')}…`)

  const title = await withPage(tab, (call) => evaluate(call, 'document.title.toUpperCase()'))
  console.log(`\nevaluate(document.title.toUpperCase()) = ${title}`)

  const missing = await withPage(tab, (call) => evaluate(call, 'document.querySelector("#nope")?.textContent ?? "нет такого"'))
  console.log(`evaluate(querySelector('#nope')) = ${missing}`)

  const shot = await withPage(tab, (call) => call('Page.captureScreenshot', { format: 'png' }))
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'dsh-shot-')), 'page.png')
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
  console.log(`\nскриншот: ${file} (${(shot.result.data.length * 0.75 / 1024).toFixed(0)} КБ)`)
} catch (error) {
  console.error(`\nОШИБКА: ${error?.message ?? error}`)
} finally {
  // The tab exists only for this run; leaving it behind is what fills the
  // user's browser with duplicates.
  await closeTab(live.origin, tab.id)
  const after = await listTabs(live.origin)
  console.log(`\nвкладка закрыта, осталось: ${after.length} (было ${before.length})`)
}