#requires -Version 5.1
<#
  Windows 0.6.25 smoke test (ASCII only, for Windows PowerShell 5.1).

  Usage (from the folder containing the exe):
    powershell -ExecutionPolicy Bypass -File .\tools\smoke-win.ps1 -Exe .\tagden-0.6.25.exe
    powershell -ExecutionPolicy Bypass -File .\tools\smoke-win.ps1 -Exe '<path-to-exe>' -ExpectedVersion 0.6.25

  It starts the exe on a free test port with isolated TAGDEN_DATA / TAGDEN_CACHE,
  checks /api/state, /, CSP and the signed update check, then stops it.
  The real user data directory is not touched. Pass -Keep to keep logs.
#>
param(
  [string]$Exe = '.\tagden-0.6.25.exe',
  [int]$Port = 7901,
  [string]$ExpectedVersion = '0.6.25',
  [int]$TimeoutSec = 60,
  [string]$ExpectedSha256 = '',
  [switch]$SkipUpdateCheck,
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'

function Fail([string]$msg) { throw "SMOKE FAIL: $msg" }

$exePath = (Resolve-Path -LiteralPath $Exe -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) { Fail "exe not found: $exePath" }

if ($ExpectedSha256) {
  $actual = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $ExpectedSha256.ToLower()) { Fail "sha256 mismatch: $actual" }
  Write-Host "PASS sha256 $actual"
}

$work = Join-Path $env:TEMP ("tagden-smoke-" + [guid]::NewGuid().ToString('N'))
$data = Join-Path $work 'data'
$cache = Join-Path $work 'cache'
New-Item -ItemType Directory -Force -Path $data, $cache | Out-Null
$outLog = Join-Path $work 'stdout.log'
$errLog = Join-Path $work 'stderr.log'

$saved = @{
  TAGDEN_DATA = $env:TAGDEN_DATA
  TAGDEN_CACHE = $env:TAGDEN_CACHE
  TAGDEN_NO_BROWSER = $env:TAGDEN_NO_BROWSER
  TAGDEN_NO_LOGIN = $env:TAGDEN_NO_LOGIN
}
$env:TAGDEN_DATA = $data
$env:TAGDEN_CACHE = $cache
$env:TAGDEN_NO_BROWSER = '1'
$env:TAGDEN_NO_LOGIN = '1'

$proc = $null
try {
  $proc = Start-Process -FilePath $exePath -ArgumentList @('--port', "$Port", '--no-open') `
    -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $state = $null
  while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { Fail "process exited early (code $($proc.ExitCode)); see $errLog" }
    try {
      $state = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 2
      break
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }
  if ($null -eq $state) { Fail "timeout waiting for /api/state on port $Port" }
  if (-not $state.ok) { Fail "/api/state ok=false" }
  if ([string]$state.version -ne $ExpectedVersion) { Fail "version $($state.version), expected $ExpectedVersion" }
  Write-Host "PASS version $($state.version), app $($state.app.id)"

  $index = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -TimeoutSec 10 -UseBasicParsing
  if ($index.StatusCode -ne 200) { Fail "index status $($index.StatusCode)" }
  if (-not $index.Headers['Content-Security-Policy']) { Fail "missing Content-Security-Policy" }
  Write-Host "PASS index 200 + CSP"

  if (-not $SkipUpdateCheck) {
    try {
      $upd = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/update/check?force=1" -TimeoutSec 30
      if (-not $upd.ok) { Fail "update check failed: $($upd.reason)" }
      if ($upd.current -ne $ExpectedVersion) { Fail "update current $($upd.current)" }
      Write-Host "PASS update check (latest $($upd.latest), hasUpdate=$($upd.hasUpdate))"
    } catch {
      Fail "update check threw: $($_.Exception.Message)"
    }
  }

  Write-Host "SMOKE PASS: $exePath"
  exit 0
} catch {
  Write-Host $_.Exception.Message
  if (Test-Path -LiteralPath $errLog) { Write-Host '--- stderr ---'; Get-Content -LiteralPath $errLog -Tail 40 }
  if (Test-Path -LiteralPath $outLog) { Write-Host '--- stdout ---'; Get-Content -LiteralPath $outLog -Tail 40 }
  exit 1
} finally {
  if ($proc -and -not $proc.HasExited) {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
  foreach ($k in @('TAGDEN_DATA','TAGDEN_CACHE','TAGDEN_NO_BROWSER','TAGDEN_NO_LOGIN')) {
    if ($null -eq $saved[$k]) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
    else { Set-Item "Env:$k" $saved[$k] }
  }
  if (-not $Keep) {
    try { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  } else {
    Write-Host "logs kept: $work"
  }
}
