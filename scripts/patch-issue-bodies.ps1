$ErrorActionPreference = 'Stop'
$env:Path += ';C:\Program Files\GitHub CLI'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$repo  = 'jackniu81/ShijiazhuangAgent'
$dir   = 'c:\workspace\ShijiazhuangAgent\scripts'
$noBom = New-Object System.Text.UTF8Encoding($false)

# map: tsv line index (0-based) -> issue number
$map = @{ 3 = 61; 4 = 62 }
$lines = Get-Content -Path "$dir\ms005-issues.tsv" -Encoding UTF8
foreach ($k in $map.Keys) {
  $t, $b = $lines[$k] -split "`t"
  $body = $b -replace '~', "`n"
  $tmp = Join-Path $dir '.gh-payload.json'
  [System.IO.File]::WriteAllText($tmp, (@{ body = $body } | ConvertTo-Json), $noBom)
  & gh api "repos/$repo/issues/$($map[$k])" -X PATCH --input $tmp | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "PATCH issue $($map[$k]) failed" }
  Write-Output "updated #$($map[$k])  $t"
}
Remove-Item (Join-Path $dir '.gh-payload.json') -ErrorAction SilentlyContinue
Write-Output 'DONE'
