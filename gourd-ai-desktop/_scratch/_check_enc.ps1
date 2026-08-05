$p = Join-Path $PSScriptRoot '..\cmd\installer.nsh'
$b = [IO.File]::ReadAllBytes($p)
Write-Output ("Size: " + $b.Length)
Write-Output ("First3Bytes: {0:X2} {1:X2} {2:X2}" -f $b[0], $b[1], $b[2])
$t = [IO.File]::ReadAllText($p)
$crlf = ([regex]::Matches($t, "`r`n")).Count
$lfOnly = 0
for ($i = 0; $i -lt $t.Length; $i++) {
  if ($t[$i] -eq "`n" -and ($i -eq 0 -or $t[$i-1] -ne "`r")) { $lfOnly++ }
}
Write-Output ("CRLF: " + $crlf)
Write-Output ("LF-only: " + $lfOnly)
$nonAscii = 0
foreach ($c in $t.ToCharArray()) { if ([int]$c -gt 127) { $nonAscii++ } }
Write-Output ("NonAsciiChars: " + $nonAscii)
