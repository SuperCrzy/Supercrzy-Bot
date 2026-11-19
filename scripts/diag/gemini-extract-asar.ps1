# SUPERCRZY - extract Gemini app.asar (ASCII only)
# Run as a normal user. Read-only: copies the asar out, never modifies the app.

$ErrorActionPreference = 'Continue'
$asar = "C:\Users\admin\AppData\Local\Google\Gemini\app-1.19.0\resources\app.asar"
$desktop = [Environment]::GetFolderPath('Desktop')
$dest = Join-Path $desktop 'gemini-asar'

Write-Host ("Source: " + $asar)
if (-not (Test-Path $asar)) {
  Write-Host "!! app.asar not found. Check the path." -ForegroundColor Red
  exit 1
}
$len = (Get-Item $asar).Length
Write-Host ("Size: " + [string][math]::Round($len/1KB) + " KB")

if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# ---- try npx @electron/asar ----
$ok = $false
Write-Host "Trying npx @electron/asar ..."
$npx = Get-Command npx -ErrorAction SilentlyContinue
if ($npx) {
  & npx --yes @electron/asar extract $asar $dest 2>&1 | ForEach-Object { Write-Host $_ }
  if (Test-Path (Join-Path $dest 'package.json')) { $ok = $true }
}

if (-not $ok) {
  Write-Host "npx route failed or unavailable. Trying manual parse ..." -ForegroundColor Yellow
  # asar format: 8-byte header (uint32 4, uint32 8), uint32 jsonLen, uint32 dataLen, json, data
  try {
    $fs = [System.IO.File]::OpenRead($asar)
    $br = New-Object System.IO.BinaryReader($fs)
    $d1 = $br.ReadUInt32(); $d2 = $br.ReadUInt32()
    $jsonLen = $br.ReadUInt32()
    $dataLen = $br.ReadUInt32()
    $jsonBytes = $br.ReadBytes([int]$jsonLen)
    $jsonText = [System.Text.Encoding]::UTF8.GetString($jsonBytes)
    $dataStart = 16 + $jsonLen
    Write-Host ("header ok: jsonLen=" + $jsonLen + " dataLen=" + $dataLen + " dataStart=" + $dataStart)

    $header = $jsonText | ConvertFrom-Json
    $script:count = 0
    function Walk($node, $prefix) {
      foreach ($p in $node.PSObject.Properties) {
        $name = $p.Name
        $n = $p.Value
        $path = if ($prefix -eq '') { $name } else { $prefix + '/' + $name }
        if ($n.PSObject.Properties.Name -contains 'files') {
          Walk $n.files $path
        } else {
          $off = [int64]$n.offset
          $sz = [int64]$n.size
          if ($n.unpacked -eq $true) { return }
          $target = Join-Path $dest ($path -replace '/', '\')
          $tdir = Split-Path $target -Parent
          if (-not (Test-Path $tdir)) { New-Item -ItemType Directory -Force -Path $tdir | Out-Null }
          $fs.Seek(($dataStart + $off), 'Begin') | Out-Null
          $buf = New-Object byte[] $sz
          $read = 0
          while ($read -lt $sz) {
            $r = $fs.Read($buf, $read, [int]($sz - $read))
            if ($r -le 0) { break }
            $read += $r
          }
          [System.IO.File]::WriteAllBytes($target, $buf)
          $script:count++
        }
      }
    }
    Walk $header.files ''
    $br.Close(); $fs.Close()
    Write-Host ("manual extract wrote " + $script:count + " files")
    if ($script:count -gt 0) { $ok = $true }
  } catch {
    Write-Host ("manual extract failed: " + $_.Exception.Message) -ForegroundColor Red
  }
}

# ---- report ----
$listFile = Join-Path $desktop 'gemini-asar-list.txt'
$files = Get-ChildItem $dest -Recurse -File -ErrorAction SilentlyContinue
$sum = ($files | Measure-Object Length -Sum).Sum
$lines = @()
$lines += "Gemini app.asar extraction"
$lines += ("Time: " + (Get-Date))
$lines += ("Source: " + $asar)
$lines += ("Extracted: " + $dest)
$lines += ("Files: " + ($files | Measure-Object).Count + "   Total: " + [string][math]::Round($sum/1MB,2) + " MB")
$lines += ""
$lines += "=== FILE LIST (path | KB) ==="
foreach ($f in ($files | Sort-Object FullName)) {
  $rel = $f.FullName.Replace($dest, '').TrimStart('\')
  $kb = [string][math]::Round($f.Length/1KB, 1)
  $lines += ($rel + " | " + $kb + " KB")
}
$lines | Set-Content -Path $listFile -Encoding UTF8

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host (" Extracted files: " + ($files | Measure-Object).Count) -ForegroundColor Cyan
Write-Host (" Total: " + [string][math]::Round($sum/1MB,2) + " MB") -ForegroundColor Cyan
Write-Host (" List file: " + $listFile) -ForegroundColor Yellow
Write-Host " Send gemini-asar-list.txt back." -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Green
