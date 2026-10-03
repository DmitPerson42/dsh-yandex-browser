// End-to-end check of the three registered tools, without a DSH restart:
// loads the plugin with a fake tool registry and drives a local test page.
//
//   node test/tools.mjs

import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../lib/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pageUrl = pathToFileURL(path.join(here, 'fixtures', 'page.html')).href

const tools = []
apply({ tools: { register: (tool) => tools.push(tool) } }, { autoStart: false })
console.log(`зарегистрировано инструментов: ${tools.length} -> ${tools.map((tool) => tool.name).join(', ')}`)

const [browser, page, act] = ['yandex_browser', 'yandex_page', 'yandex_act'].map((name) => tools.find((tool) => tool.name === name))
if (!page || !act) {
  console.error('Инструменты страниц не зарегистрированы.')
  process.exit(1)
}

const show = async (title, value) => {
  console.log(`\n### ${title}`)
  console.log(value.message)
  return value
}

const status = await browser.execute({ action: 'status' })
await show('yandex_browser status', status)
if (!status.running) {
  console.error('Браузер не запущен: сначала вызови yandex_browser с action "start".')
  process.exit(1)
}

const opened = await act.execute({ action: 'navigate', url: pageUrl, newTab: true })
await show('открыли тестовую страницу в новой вкладке', opened)
const tab = opened.tabId

const read = await page.execute({ action: 'text', tab, maxChars: 300, maxElements: 10 })
await show('прочитали страницу', read)
console.log('элементы:', read.elements.map((element) => `${element.tag}:${element.label}`).join(' | '))

await show('ввели текст', await act.execute({ action: 'type', tab, selector: '#name', value: 'Дмитрий' }))
await show('нажали кнопку по тексту', await act.execute({ action: 'click', tab, text: 'Показать' }))

const statusText = await page.execute({ action: 'eval', tab, expression: 'document.getElementById("status").textContent' })
await show('прочитали результат через eval', statusText)
if (statusText.value !== 'Привет, Дмитрий') {
  console.error(`Ожидалось "Привет, Дмитрий", получено "${statusText.value}"`)
  process.exit(1)
}

await show('кликнули по aria-label', await act.execute({ action: 'click', tab, selector: '#clear' }))
await show('проверили поле', await page.execute({ action: 'eval', tab, expression: 'document.getElementById("name").value' }))

const shot = await page.execute({ action: 'screenshot', tab, fullPage: true })
await show('сделали скриншот', shot)

await show('закрыли вкладку', await act.execute({ action: 'close', tab }))
console.log('\nВсе проверки прошли.')