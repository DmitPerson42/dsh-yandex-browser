# Installs the plugin into the DSH profile and reports the composition entry to add.
# Idempotent: re-running refreshes the files and never duplicates the patch entry.
[CmdletBinding()]
param(
  [string]$Profile = "$env:USERPROFILE\.dsh\profiles\web"
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$target = "$env:USERPROFILE\.dsh\plugins\dsh-yandex-browser"
$patch = Join-Path $Profile 'cordis.patch.yml'

Write-Host '1/2 Копирую плагин в профиль DSH'
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item (Join-Path $source 'package.json') $target -Force
Copy-Item (Join-Path $source 'lib') $target -Recurse -Force
Copy-Item (Join-Path $source 'test') $target -Recurse -Force
Copy-Item (Join-Path $source 'README.md') $target -Force
Write-Host "    -> $target"

Write-Host '2/2 Проверяю cordis.patch.yml'
$entry = @"

- id: yandex-browser
  name: "file:///$($target -replace '\\','/')/lib/index.js"
  config:
    autoStart: true
"@

if (Test-Path $patch) {
  if (Select-String -Path $patch -Pattern 'id: yandex-browser' -Quiet) {
    Write-Host "    запись yandex-browser уже есть: $patch"
  } else {
    Write-Host "    ДОБАВЬ В $patch :"
    Write-Host $entry
  }
  if (Select-String -Path $patch -Pattern '"@playwright/mcp@latest"' -Quiet) {
    $positional = Select-String -Path $patch -Pattern '^\s+- "http://127\.0\.0\.1:9222"\s*$' -Quiet
    if ($positional) {
      $fix = @'
  args:
    - "-y"
    - "@playwright/mcp@latest"
    - "--cdp-endpoint"
    - !!js "`process.env.YANDEX_CDP ?? 'http://127.0.0.1:9222'`"
'@
      Write-Warning 'В MCP-клиенте yandex адрес передан позиционным аргументом.'
      Write-Warning 'Playwright MCP его не принимает. Замени блок args на:'
      Write-Warning $fix
    }
  }
} else {
  Write-Host "    не найден $patch — создайте его вручную:"
  Write-Host $entry
}

Write-Host ''
Write-Host 'Готово. Перезапусти DSH GUI, затем один раз войди в аккаунты в окне браузера.'
