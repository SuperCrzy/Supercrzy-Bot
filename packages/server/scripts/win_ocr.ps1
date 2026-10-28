# Windows.Media.Ocr shim (2026-10-26, revised after design review).
#
# Purpose: give the agent OCR on Windows with ZERO shipped dependencies.
# Windows 10 1809+ / Windows 11 ship the WinRT OCR engine; it is far better on
# anti-aliased UI text than Tesseract (which is trained on scanned documents).
#
# Contract: prints one line of JSON on stdout, `{"texts":[...]}` on success or
# `{"texts":[],"error":"..."}` on failure, and exits non-zero on failure.
# The caller (services/ocr-engine.ts) parses stdout, never stderr.
#
# Caveats:
#   - Recognition languages come from installed Windows language packs; a machine
#     with no OCR pack installed cannot be helped here (caller falls back).
#   - OcrEngine.MaxImageDimension rejects oversized bitmaps outright. 4K screenshots
#     are common for computer_use captures, so we pre-scale with System.Drawing
#     (ships with Windows .NET) and OCR a temp PNG copy instead of failing.

param([Parameter(Mandatory = $true)][string]$ImagePath)

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 writes redirected stdout in the OEM codepage, which mangles CJK
# text the moment the Node caller decodes the pipe as UTF-8. Pin UTF-8 explicitly
# so the JSON contract holds on every locale.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Json($obj) {
  $obj | ConvertTo-Json -Compress -Depth 3
}

try {
  if (-not (Test-Path -LiteralPath $ImagePath)) { throw "image not found: $ImagePath" }

  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

  # WinRT async → sync bridge (PowerShell 5.1 has no await)
  $asTaskMethods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  }
  if (-not $asTaskMethods) { throw 'WinRT task bridge unavailable' }
  $asTask = $asTaskMethods[0]

  function Await($operation, $resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    [void]$task.Wait(-1)
    return $task.Result
  }

  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Storage.FileAccessMode, Windows.Foundation, ContentType = WindowsRuntime]

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) {
    throw 'no OCR language pack installed (Settings > Time & Language > Language > Options > OCR)'
  }

  $ocrPath = (Resolve-Path -LiteralPath $ImagePath).Path

  # Pre-scale oversized images BEFORE WinRT decode (MaxImageDimension is a hard reject).
  Add-Type -AssemblyName System.Drawing | Out-Null
  $probe = [System.Drawing.Image]::FromFile($ocrPath)
  $w = $probe.Width; $h = $probe.Height; $probe.Dispose()
  $maxDim = $engine.MaxImageDimension
  $tmpScaled = $null
  if ($w -gt $maxDim -or $h -gt $maxDim) {
    $scale = $maxDim / [double][Math]::Max($w, $h)
    $nw = [Math]::Max(1, [int]($w * $scale))
    $nh = [Math]::Max(1, [int]($h * $scale))
    $tmpScaled = Join-Path ([System.IO.Path]::GetTempPath()) ("supercrzy-ocr-" + [Guid]::NewGuid().ToString('N') + ".png")
    $src = [System.Drawing.Image]::FromFile($ocrPath)
    $bmp = New-Object System.Drawing.Bitmap($nw, $nh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($src, 0, 0, $nw, $nh)
    $g.Dispose(); $src.Dispose()
    $bmp.Save($tmpScaled, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    $ocrPath = $tmpScaled
  }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ocrPath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  $lines = New-Object System.Collections.ArrayList
  foreach ($line in $result.Lines) { [void]$lines.Add($line.Text) }

  if ($tmpScaled) { Remove-Item -LiteralPath $tmpScaled -Force -ErrorAction SilentlyContinue }

  Write-Json @{ texts = @($lines) }
  exit 0
}
catch {
  Write-Json @{ texts = @(); error = $_.Exception.Message }
  exit 1
}
