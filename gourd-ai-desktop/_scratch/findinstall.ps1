$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Write-Output "=== Uninstall entries matching Gourd ==="
$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
foreach ($r in $roots) {
  Get-ItemProperty $r -ErrorAction SilentlyContinue | Where-Object {
    $_.DisplayName -match 'Gourd' -or $_.InstallLocation -match 'gourd'
  } | ForEach-Object {
    "DisplayName   : " + $_.DisplayName
    "InstallLoc    : " + $_.InstallLocation
    "UninstallStr  : " + $_.UninstallString
    "---"
  }
}

Write-Output ""
Write-Output "=== running Gourd processes + their exe path ==="
Get-Process | Where-Object { $_.ProcessName -match 'Gourd' -or $_.MainWindowTitle -match 'Gourd' } |
  ForEach-Object {
    try { $p = $_.Path } catch { $p = '(no access)' }
    "PID {0}  Name={1}  Path={2}" -f $_.Id, $_.ProcessName, $p
  }

Write-Output ""
Write-Output "=== Start Menu shortcuts ==="
$sm = @(
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
  "$env:ProgramData\Microsoft\Windows\Start Menu\Programs"
)
foreach ($d in $sm) {
  Get-ChildItem -Path $d -Recurse -Filter '*Gourd*' -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName }
}
"done"
