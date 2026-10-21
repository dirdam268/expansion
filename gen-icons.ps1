Add-Type -AssemblyName System.Drawing

# Icono: fondo turquesa con una cuadricula 3x3 de manzanas (una marcada en verde), como el plano de la app
function New-Icon([int]$size, [string]$path, [bool]$rounded, [double]$pad) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 27, 127, 149))   # #1b7f95

  if ($rounded) {
    $r = $size * 0.22; $d = $r * 2
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $gp.AddArc(0, 0, $d, $d, 180, 90); $gp.AddArc($size - $d, 0, $d, $d, 270, 90)
    $gp.AddArc($size - $d, $size - $d, $d, $d, 0, 90); $gp.AddArc(0, $size - $d, $d, $d, 90, 90)
    $gp.CloseFigure(); $g.FillPath($brush, $gp)
  } else { $g.FillRectangle($brush, 0, 0, $size, $size) }

  $inner = $size * (1 - $pad * 2); $ox = $size * $pad; $oy = $size * $pad
  $gap = $inner * 0.07; $cell = ($inner - 2 * $gap) / 3
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 255, 255, 255))
  $green = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 96, 214, 150))
  for ($r = 0; $r -lt 3; $r++) { for ($c = 0; $c -lt 3; $c++) {
    $x = $ox + $c * ($cell + $gap); $y = $oy + $r * ($cell + $gap)
    $b = if ($r -eq 1 -and $c -eq 1) { $green } else { $white }
    $g.FillRectangle($b, [single]$x, [single]$y, [single]$cell, [single]$cell)
  } }
  $g.Dispose(); $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}

$d = Join-Path $PSScriptRoot 'icons'
New-Item -ItemType Directory -Force $d | Out-Null
New-Icon 192 (Join-Path $d 'icon-192.png') $true 0.20
New-Icon 512 (Join-Path $d 'icon-512.png') $true 0.20
New-Icon 512 (Join-Path $d 'icon-512-maskable.png') $false 0.28
New-Icon 180 (Join-Path $d 'apple-touch-icon.png') $false 0.20
New-Icon 32  (Join-Path $d 'favicon-32.png') $true 0.12
Write-Host 'Iconos generados en icons\'
