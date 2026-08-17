# Captura la VENTANA de VS Code de la demo (no el escritorio) cada vez que el guion deja
# una marca en media/shots/.step-*. Uso, en paralelo a `npm run demo`:
#   powershell -ExecutionPolicy Bypass -File scripts/capture-window.ps1
param(
  [string]$ShotsDir = "media/shots",
  [int]$TimeoutSeconds = 120
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool repaint);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$dir = Join-Path (Get-Location) $ShotsDir
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Get-ChildItem -Path $dir -Filter ".step-*" -Force -ErrorAction SilentlyContinue | Remove-Item -Force

Write-Host "esperando la ventana de VS Code de la demo..."
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$proc = $null
while ((Get-Date) -lt $deadline -and -not $proc) {
  $proc = Get-Process -Name Code -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -match "checkout-service" } |
    Select-Object -First 1
  if (-not $proc) { Start-Sleep -Milliseconds 500 }
}
if (-not $proc) { Write-Host "no aparecio la ventana"; exit 1 }

$h = $proc.MainWindowHandle
[Win]::MoveWindow($h, 60, 40, 1400, 900, $true) | Out-Null
[Win]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 800

$taken = @{}
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  foreach ($m in Get-ChildItem -Path $dir -Filter ".step-*" -Force -ErrorAction SilentlyContinue) {
    $name = $m.Name.Substring(6)
    if ($taken.ContainsKey($name)) { continue }
    $taken[$name] = $true
    Start-Sleep -Milliseconds 900
    $r = New-Object Win+RECT
    [Win]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left
    $ht = $r.Bottom - $r.Top
    if ($w -le 0 -or $ht -le 0) { continue }
    $bmp = New-Object System.Drawing.Bitmap($w, $ht)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
    $out = Join-Path $dir "$name.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Host "capturado $out"
    Remove-Item $m.FullName -Force
  }
  Start-Sleep -Milliseconds 400
  if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) { break }
}
Write-Host "fin de la captura"
