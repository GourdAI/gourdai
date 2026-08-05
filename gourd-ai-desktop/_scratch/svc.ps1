$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Write-Output "=== QQPC processes ==="
Get-Process | Where-Object { $_.ProcessName -match 'QQPC' } | ForEach-Object {
  try { $p = $_.Path } catch { $p = '(no access)' }
  "PID {0}  {1}  {2}" -f $_.Id, $_.ProcessName, $p
}

Write-Output ""
Write-Output "=== QQPC services (state + start mode) ==="
Get-CimInstance Win32_Service -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'QQPC|Tencent|QMUsbGuard|QPCore' -or $_.DisplayName -match '电脑管家|Tencent' } |
  ForEach-Object { "{0,-24} State={1,-8} Start={2,-10} {3}" -f $_.Name, $_.State, $_.StartMode, $_.DisplayName }

Write-Output ""
Write-Output "=== JAVA_HOME / jlink availability (for rebuilding JRE) ==="
"JAVA_HOME = " + $env:JAVA_HOME
if ($env:JAVA_HOME) {
  $jl = Join-Path $env:JAVA_HOME 'bin\jlink.exe'
  "jlink exists: " + (Test-Path $jl)
  $jv = Join-Path $env:JAVA_HOME 'bin\java.exe'
  if (Test-Path $jv) { & $jv -version 2>&1 | Select-Object -First 1 }
}
"done"
