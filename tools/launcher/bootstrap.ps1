# BeakSight の起動の前に、条件を満たす Node.js を用意する（Windows。設計書 doc/design/2026-11-08-beaksight-root-launcher-design.md 3.3.1）。
# BeakSight.cmd が呼ぶ。標準出力には、使う Node.js のフォルダを 1 行だけ書く（BeakSight.cmd が PATH の先頭に置く）。説明は標準エラーに書く。
# 用意できなければ、何も書かずに終了コード 1 で終わる。
#
# 1. PATH の node が package.json の engines.node を満たせば、それを使う。
# 2. 満たさない（または node がない）ときは、BeakSight 専用の置き場所 local\runtime\ に置いた Node.js のうち、条件を満たすいちばん新しいものを使う。
# 3. なければ、nodejs.org の公式の一覧（index.json）から条件を満たすいちばん新しい版を選び、公式の配布物（win-x64 の zip）と SHASUMS256.txt を
#    取ってきて、SHA-256 が合えば展開して local\runtime\node-v<版>-win-x64\ に置く。取ってくる先は nodejs.org（https）だけ。
# PC 全体の Node.js と PATH の設定は変えない。版の比べの決まりは tools/launcher/start.mjs の checkNodeVersion と同じ。
#
# -LoadOnly: 関数を読み込むだけで、何もしない（テストで、ドットで読み込んで関数を確かめるため）。
param(
  [switch]$LoadOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# 公式の配布の場所（これのほかから取ってこない）。
$NodeDistBase = 'https://nodejs.org/dist'
# 使う配布物の種類（index.json の files の名前と、配布物の名前の環境）。
$NodeFileKey = 'win-x64-zip'
$NodePlatform = 'win-x64'

# 利用者向けの文（Node.js がまだないときの文。ほかの文は start.mjs の LAUNCHER_TEXT）。
$BootstrapText = @{
  preparing        = 'BeakSight 用の Node.js（{0}）を用意します。少し時間がかかります。'
  rangeUnreadable  = 'BeakSight を起動できません。必要な Node.js の版を読めませんでした。'
  noRelease        = 'BeakSight を起動できません。合う版の Node.js が見つかりませんでした。'
  downloadFailed   = 'BeakSight を起動できません。Node.js を取ってこられませんでした。インターネットにつながっているかを確かめてください。'
  hashMismatch     = 'BeakSight を起動できません。取ってきた Node.js が正しいものか確かめられませんでした。'
  extractFailed    = 'BeakSight を起動できません。取ってきた Node.js を展開できませんでした。'
  manual           = '手で入れるときは、https://nodejs.org/ から Node.js（{0}）を入れてから、もう一度起動してください。'
}

function Write-BootstrapError([string]$Line) {
  [Console]::Error.WriteLine($Line)
}

# 版の文字列（v24.22.1）を 3 つの数にする。読めなければ $null。
function ConvertTo-NodeVersionParts([string]$Text) {
  if ($Text -match '^v?(\d+)\.(\d+)\.(\d+)$') {
    return , @([int64]$Matches[1], [int64]$Matches[2], [int64]$Matches[3])
  }
  return $null
}

# 3 つの数の比べ（-1・0・1）。
function Compare-NodeVersionParts($Left, $Right) {
  for ($index = 0; $index -lt 3; $index++) {
    if ($Left[$index] -lt $Right[$index]) { return -1 }
    if ($Left[$index] -gt $Right[$index]) { return 1 }
  }
  return 0
}

# Version が Range を満たすか（SATISFIED・NOT_SATISFIED・UNREADABLE）。空白で区切った比べの全部を満たせば SATISFIED。
# 省いた版は >= と < のときだけ読む。^・~・||・x などは UNREADABLE。
function Get-NodeVersionStatus([string]$Range, [string]$Version) {
  $parts = ConvertTo-NodeVersionParts $Version
  $tokens = @(($Range.Trim() -split '\s+') | Where-Object { $_ -ne '' })
  if ($null -eq $parts -or $tokens.Count -eq 0) { return 'UNREADABLE' }
  $satisfied = $true
  foreach ($token in $tokens) {
    if ($token -notmatch '^(>=|<=|>|<|=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$') { return 'UNREADABLE' }
    $operator = if ($Matches[1]) { $Matches[1] } else { '=' }
    $partial = -not $Matches.ContainsKey(4)
    if ($partial -and $operator -ne '>=' -and $operator -ne '<') { return 'UNREADABLE' }
    $minor = if ($Matches.ContainsKey(3)) { [int64]$Matches[3] } else { 0 }
    $patch = if ($Matches.ContainsKey(4)) { [int64]$Matches[4] } else { 0 }
    $order = Compare-NodeVersionParts $parts @([int64]$Matches[2], $minor, $patch)
    $ok = switch ($operator) {
      '>=' { $order -ge 0 }
      '>' { $order -gt 0 }
      '<=' { $order -le 0 }
      '<' { $order -lt 0 }
      default { $order -eq 0 }
    }
    if (-not $ok) { $satisfied = $false }
  }
  if ($satisfied) { return 'SATISFIED' }
  return 'NOT_SATISFIED'
}

# index.json（文字列）から、FileKey の配布物があり、Range を満たすいちばん新しい版（v を除く）を返す。なければ ''。
function Select-NodeRelease([string]$IndexJson, [string]$FileKey, [string]$Range) {
  $best = $null
  $bestParts = $null
  # Windows PowerShell 5.1 の ConvertFrom-Json は、配列を 1 つのものとして流すので、いったん変数に入れてから 1 つずつ見る。
  $releases = $IndexJson | ConvertFrom-Json
  foreach ($release in $releases) {
    if (@($release.files) -notcontains $FileKey) { continue }
    if ((Get-NodeVersionStatus -Range $Range -Version $release.version) -ne 'SATISFIED') { continue }
    $parts = ConvertTo-NodeVersionParts $release.version
    if ($null -eq $bestParts -or (Compare-NodeVersionParts $parts $bestParts) -gt 0) {
      $best = $release.version.TrimStart('v')
      $bestParts = $parts
    }
  }
  if ($null -eq $best) { return '' }
  return $best
}

# SHASUMS256.txt（文字列）から、FileName の SHA-256 を返す（名前の完全な一致だけ）。なければ ''。
function Get-ExpectedSha256([string]$ShasumsText, [string]$FileName) {
  foreach ($line in ($ShasumsText -split '\r?\n')) {
    if ($line -match '^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$' -and $Matches[2] -ceq $FileName) {
      return $Matches[1].ToLowerInvariant()
    }
  }
  return ''
}

# ファイルの SHA-256 が Expected と同じか（大文字と小文字を区別しない）。
function Test-FileSha256([string]$Path, [string]$Expected) {
  if ($Expected -notmatch '^[0-9a-fA-F]{64}$') { return $false }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
  return $actual.ToLowerInvariant() -eq $Expected.ToLowerInvariant()
}

# 置き場所（RuntimeDirectory）の node-v<版>-win-x64\node.exe のうち、Range を満たすいちばん新しいもののフォルダ。なければ ''。
function Get-LocalNodeDirectory([string]$RuntimeDirectory, [string]$Range) {
  if (-not (Test-Path -LiteralPath $RuntimeDirectory -PathType Container)) { return '' }
  $best = ''
  $bestParts = $null
  foreach ($directory in @(Get-ChildItem -LiteralPath $RuntimeDirectory -Directory)) {
    if ($directory.Name -notmatch ('^node-(v\d+\.\d+\.\d+)-' + [regex]::Escape($NodePlatform) + '$')) { continue }
    $version = $Matches[1]
    if (-not (Test-Path -LiteralPath (Join-Path $directory.FullName 'node.exe') -PathType Leaf)) { continue }
    if ((Get-NodeVersionStatus -Range $Range -Version $version) -ne 'SATISFIED') { continue }
    $parts = ConvertTo-NodeVersionParts $version
    if ($null -eq $bestParts -or (Compare-NodeVersionParts $parts $bestParts) -gt 0) {
      $best = $directory.FullName
      $bestParts = $parts
    }
  }
  return $best
}

# PATH の node が Range を満たせば、そのフォルダ。なければ ''。
function Get-PathNodeDirectory([string]$Range) {
  $command = Get-Command -Name 'node' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $command) { return '' }
  try {
    $version = (& $command.Source --version 2>$null | Select-Object -First 1)
  } catch {
    return ''
  }
  if ((Get-NodeVersionStatus -Range $Range -Version ([string]$version).Trim()) -ne 'SATISFIED') { return '' }
  return (Split-Path -Parent $command.Source)
}

# nodejs.org から取ってくる（https だけ）。
function Save-NodeDistFile([string]$RelativePath, [string]$Destination) {
  Invoke-WebRequest -UseBasicParsing -Uri ($NodeDistBase + '/' + $RelativePath) -OutFile $Destination
}

# 条件を満たす Node.js を取ってきて置き、そのフォルダを返す。失敗したら説明を出して ''。
function Install-NodeRuntime([string]$RuntimeDirectory, [string]$Range) {
  # この process だけの設定（古い Windows の既定の TLS で取ってこられないことを防ぐ。進み具合の表示は取ってくるのを遅くするので止める）。
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'
  New-Item -ItemType Directory -Force -Path $RuntimeDirectory | Out-Null
  $work = Join-Path $RuntimeDirectory ('download-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  try {
    try {
      Save-NodeDistFile 'index.json' (Join-Path $work 'index.json')
    } catch {
      Write-BootstrapError $BootstrapText.downloadFailed
      return ''
    }
    $version = Select-NodeRelease -IndexJson ([System.IO.File]::ReadAllText((Join-Path $work 'index.json'))) -FileKey $NodeFileKey -Range $Range
    if ($version -eq '') {
      Write-BootstrapError $BootstrapText.noRelease
      return ''
    }
    Write-BootstrapError ($BootstrapText.preparing -f ('v' + $version))
    $name = 'node-v' + $version + '-' + $NodePlatform
    $archive = Join-Path $work ($name + '.zip')
    try {
      Save-NodeDistFile ('v' + $version + '/SHASUMS256.txt') (Join-Path $work 'SHASUMS256.txt')
      Save-NodeDistFile ('v' + $version + '/' + $name + '.zip') $archive
    } catch {
      Write-BootstrapError $BootstrapText.downloadFailed
      return ''
    }
    $expected = Get-ExpectedSha256 -ShasumsText ([System.IO.File]::ReadAllText((Join-Path $work 'SHASUMS256.txt'))) -FileName ($name + '.zip')
    if (-not (Test-FileSha256 -Path $archive -Expected $expected)) {
      Write-BootstrapError $BootstrapText.hashMismatch
      return ''
    }
    $target = Join-Path $RuntimeDirectory $name
    try {
      $extracted = Join-Path $work 'extracted'
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $extracted)
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
      Move-Item -LiteralPath (Join-Path $extracted $name) -Destination $target
    } catch {
      Write-BootstrapError $BootstrapText.extractFailed
      return ''
    }
    $nodeExe = Join-Path $target 'node.exe'
    if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
      Write-BootstrapError $BootstrapText.extractFailed
      return ''
    }
    return $target
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# 入口。使う Node.js のフォルダを返す。用意できなければ、説明を出して ''。
function Invoke-NodeBootstrap {
  $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  $runtime = Join-Path (Join-Path $root 'local') 'runtime'
  $range = ''
  try {
    $package = [System.IO.File]::ReadAllText((Join-Path $root 'package.json')) | ConvertFrom-Json
    if ($null -ne $package.engines -and $package.engines.node -is [string]) { $range = $package.engines.node }
  } catch {
    $range = ''
  }
  # 版の決まりを読めないとき: PATH の node があれば、版を確かめずに使う（start.mjs が注意を出す）。なければ止める。
  if ((Get-NodeVersionStatus -Range $range -Version 'v0.0.0') -eq 'UNREADABLE') {
    $command = Get-Command -Name 'node' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) { return (Split-Path -Parent $command.Source) }
    Write-BootstrapError $BootstrapText.rangeUnreadable
    return ''
  }
  $fromPath = Get-PathNodeDirectory -Range $range
  if ($fromPath -ne '') { return $fromPath }
  $local = Get-LocalNodeDirectory -RuntimeDirectory $runtime -Range $range
  if ($local -ne '') { return $local }
  $installed = Install-NodeRuntime -RuntimeDirectory $runtime -Range $range
  if ($installed -ne '') { return $installed }
  Write-BootstrapError ($BootstrapText.manual -f $range)
  return ''
}

if (-not $LoadOnly) {
  $directory = ''
  try {
    $directory = [string](Invoke-NodeBootstrap)
  } catch {
    Write-BootstrapError $_.Exception.Message
    $directory = ''
  }
  if ($directory -eq '') { exit 1 }
  Write-Output $directory
  exit 0
}
