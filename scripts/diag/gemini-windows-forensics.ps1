# SUPERCRZY - Gemini Windows forensics (ASCII only, no format strings)
# Usage: run in PowerShell on Windows as a normal user.
# Output: Desktop\gemini-forensics-<time>.txt  -- send that file back.

$ErrorActionPreference = 'SilentlyContinue'
$out = Join-Path ([Environment]::GetFolderPath('Desktop')) ("gemini-forensics-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".txt")

function W($s) { Add-Content -Path $out -Value $s -Encoding UTF8 }
function Sep($t) { W ""; W ("=" * 70); W ("## " + $t); W ("=" * 70) }
function KB($n) { return [string][math]::Round($n / 1KB) }
function MB($n) { return [string][math]::Round($n / 1MB, 1) }

W "SUPERCRZY Gemini Windows Forensics"
W ("Time: " + (Get-Date))
W ("Host: " + $env:COMPUTERNAME)
W ("OS: " + (Get-CimInstance Win32_OperatingSystem).Caption + " build " + (Get-CimInstance Win32_OperatingSystem).Version)

# ---------- 1. locate install dir ----------
Sep "1. INSTALL DIR"
$roots = @(
  "$env:LOCALAPPDATA\Google",
  "$env:PROGRAMFILES\Google",
  "${env:PROGRAMFILES(X86)}\Google",
  "$env:LOCALAPPDATA\Programs",
  "$env:PROGRAMFILES",
  "${env:PROGRAMFILES(X86)}"
)
$found = @()
foreach ($r in $roots) {
  if (Test-Path $r) {
    Get-ChildItem $r -Directory | Where-Object { $_.Name -match 'Gemini' } | ForEach-Object {
      $found += $_.FullName
      W ("FOUND: " + $_.FullName)
    }
  }
}
if ($found.Count -eq 0) {
  W "Not in usual paths. Checking Start Menu shortcuts..."
  $dirs = @("$env:APPDATA\Microsoft\Windows\Start Menu", "$env:PROGRAMDATA\Microsoft\Windows\Start Menu")
  foreach ($d in $dirs) {
    Get-ChildItem $d -Recurse -Filter "*Gemini*.lnk" | ForEach-Object {
      W ("LNK: " + $_.FullName)
      $sh = New-Object -ComObject WScript.Shell
      $t = $sh.CreateShortcut($_.FullName)
      W ("  target: " + $t.TargetPath)
      W ("  args:   " + $t.Arguments)
      if ($t.TargetPath) { $found += (Split-Path $t.TargetPath -Parent) }
    }
  }
}

# ---------- 2. structure and size ----------
Sep "2. STRUCTURE AND SIZE"
foreach ($p in ($found | Select-Object -Unique)) {
  if (-not (Test-Path $p)) { continue }
  W ("--- " + $p)
  $files = Get-ChildItem $p -Recurse -File
  $sum = ($files | Measure-Object Length -Sum).Sum
  W ("TOTAL: " + (MB $sum) + " MB   FILES: " + ($files | Measure-Object).Count)
  W "TOP LEVEL:"
  Get-ChildItem $p | ForEach-Object {
    $tag = ""
    if ($_.PSIsContainer) { $tag = "[DIR] " }
    W ("  " + $tag + $_.Name)
  }
  W "BIG exe/dll (top 60):"
  $files | Where-Object { $_.Extension -eq '.exe' -or $_.Extension -eq '.dll' } |
    Sort-Object Length -Descending | Select-Object -First 60 | ForEach-Object {
      $rel = $_.DirectoryName.Replace($p, ".")
      W ("  " + $_.Name.PadRight(45) + " " + (KB $_.Length).PadLeft(9) + " KB  " + $rel)
    }
  W "KEY FILES PRESENT:"
  $keys = @('chrome_elf.dll','chrome.dll','libcef.dll','cef.pak','icudtl.dat','snapshot_blob.bin','v8_context_snapshot.bin','resources.pak','app.asar','Gemini.exe','GeminiApp.exe','WebView2Loader.dll','msedgewebview2.exe','ffmpeg.dll','electron.exe')
  foreach ($k in $keys) {
    $hit = $files | Where-Object { $_.Name -eq $k } | Select-Object -First 1
    if ($hit) {
      $rel = $hit.DirectoryName.Replace($p, ".")
      W ("  [YES] " + $k + "  " + (KB $hit.Length) + " KB  " + $rel)
    }
  }
}

# ---------- 3. running process + loaded modules ----------
Sep "3. PROCESS AND LOADED MODULES"
$procs = Get-Process | Where-Object { $_.Name -match 'Gemini' }
if ($procs) {
  foreach ($pr in $procs) {
    W ("PROC: " + $pr.Name + "  PID=" + $pr.Id + "  Path=" + $pr.Path)
    $ci = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $pr.Id)
    if ($ci) { W ("  cmdline: " + $ci.CommandLine) }
    W "  loaded modules matching browser engines:"
    try {
      $mods = $pr.Modules | Where-Object { $_.ModuleName -match 'chrome|cef|webkit|edge|electron|v8|blink' } | Select-Object -First 30
      foreach ($m in $mods) { W ("    " + $m.ModuleName + "  <- " + $m.FileName) }
    } catch {
      W "    (cannot read modules)"
    }
  }
} else {
  W "!! Gemini is not running. Start the app and run section 3 again."
}

# ---------- 4. endpoints + capability keywords ----------
Sep "4. ENDPOINTS AND CAPABILITY KEYWORDS"
foreach ($p in ($found | Select-Object -Unique)) {
  if (-not (Test-Path $p)) { continue }
  $bins = Get-ChildItem $p -Recurse -File -Include *.exe,*.dll | Sort-Object Length -Descending | Select-Object -First 3
  foreach ($b in $bins) {
    W ("--- scanning " + $b.Name + "  " + (MB $b.Length) + " MB")
    $bytes = [System.IO.File]::ReadAllBytes($b.FullName)
    $ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
    $urls = [regex]::Matches($ascii, 'https://[a-zA-Z0-9\.\-]+/[a-zA-Z0-9\./_\-]{0,60}') | ForEach-Object { $_.Value } | Where-Object { $_ -match 'gemini|google|googleapis|gstatic' } | Sort-Object -Unique | Select-Object -First 40
    W "  URL samples:"
    foreach ($u in $urls) { W ("    " + $u) }
    $pat = '(AgentBrowser[A-Za-z]*|Grounding[A-Za-z]*|BrowserAnnotation[A-Za-z]*|ComputerUse[A-Za-z]*|DeepResearch[A-Za-z]*|web_search|url_context|accessibility[A-Za-z]*)'
    $kw = [regex]::Matches($ascii, $pat) | ForEach-Object { $_.Value } | Group-Object | Sort-Object Count -Descending | Select-Object -First 25
    W "  keyword hits:"
    foreach ($k in $kw) { W ("    " + $k.Name.PadRight(40) + " x" + $k.Count) }
  }
}

# ---------- 5. WebView2 runtime ----------
Sep "5. WEBVIEW2 RUNTIME"
$wv = @("${env:PROGRAMFILES(X86)}\Microsoft\EdgeWebView\Application", "$env:PROGRAMFILES\Microsoft\EdgeWebView\Application")
foreach ($w in $wv) {
  if (Test-Path $w) {
    Get-ChildItem $w -Directory | ForEach-Object { W ("WebView2 version: " + $_.Name + "  (" + $w + ")") }
  }
}
$reg = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\*"
foreach ($r in $reg) { if ($r.name -match 'WebView2') { W ("REG WebView2: " + $r.name + " pv=" + $r.pv) } }

# ---------- 6. verdict ----------
Sep "6. VERDICT"
$all = @()
foreach ($p in ($found | Select-Object -Unique)) { if (Test-Path $p) { $all += Get-ChildItem $p -Recurse -File } }
function Has($name) { $c = ($all | Where-Object { $_.Name -eq $name }).Count; return [string]($c -gt 0) }
W ("libcef.dll             : " + (Has 'libcef.dll'))
W ("chrome.dll             : " + (Has 'chrome.dll'))
W ("app.asar               : " + (Has 'app.asar'))
W ("electron.exe           : " + (Has 'electron.exe'))
W ("WebView2Loader.dll     : " + (Has 'WebView2Loader.dll'))
W ("msedgewebview2.exe     : " + (Has 'msedgewebview2.exe'))
W ""
W "How to read this:"
W "  libcef.dll            = bundles CEF (Chromium Embedded Framework)"
W "  app.asar              = Electron app (bundles Chromium)"
W "  WebView2Loader.dll    = uses system WebView2 (Edge Chromium, small install)"
W "  none of the above     = native shell with remote rendering"

Sep "DONE"
W ("Output: " + $out)

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host " DONE" -ForegroundColor Green
Write-Host (" File: " + $out) -ForegroundColor Cyan
Write-Host " Send that txt back." -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Green
