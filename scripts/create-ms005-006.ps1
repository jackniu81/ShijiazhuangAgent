$ErrorActionPreference = 'Stop'
$env:Path += ';C:\Program Files\GitHub CLI'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$repo  = 'jackniu81/ShijiazhuangAgent'
$dir   = 'c:\workspace\ShijiazhuangAgent\scripts'
$noBom = New-Object System.Text.UTF8Encoding($false)

function Invoke-GhJson($method, $endpoint, $obj) {
  $tmp = Join-Path $dir '.gh-payload.json'
  [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 5), $noBom)
  $res = & gh api $endpoint -X $method --input $tmp 2>&1
  if ($LASTEXITCODE -ne 0) { throw "$method $endpoint failed: $res" }
  return ($res | ConvertFrom-Json)
}

function New-Milestone($title, $descFile) {
  $ms = Invoke-GhJson 'POST' "repos/$repo/milestones" @{
    title       = $title
    description = (Get-Content $descFile -Encoding UTF8 -Raw).Trim()
  }
  return $ms.number
}

function New-Issues($file, $milestoneNumber) {
  foreach ($line in (Get-Content -Path $file -Encoding UTF8)) {
    if (-not $line.Trim()) { continue }
    $t, $b = $line -split "`t"
    $body = $b -replace '~', "`n"
    $res = Invoke-GhJson 'POST' "repos/$repo/issues" @{ title = $t; body = $body; milestone = $milestoneNumber }
    Write-Output "  new #$($res.number)  $($res.title)"
  }
}

function Move-Issues($numbers, $milestoneNumber) {
  foreach ($n in $numbers) {
    Invoke-GhJson 'PATCH' "repos/$repo/issues/$n" @{ milestone = $milestoneNumber } | Out-Null
    Write-Output "  moved #$n -> milestone $milestoneNumber"
  }
}

$ms5 = New-Milestone 'MS-005: Production Baseline' "$dir\ms005-desc.txt"
$ms6 = New-Milestone 'MS-006: Differentiation Loop' "$dir\ms006-desc.txt"
Write-Output "MILESTONE $ms5 = MS-005: Production Baseline"
Write-Output "MILESTONE $ms6 = MS-006: Differentiation Loop"

New-Issues "$dir\ms005-issues.tsv" $ms5
New-Issues "$dir\ms006-issues.tsv" $ms6

Write-Output '--- moves from MS-999 ---'
Move-Issues @(27, 29, 36) $ms5
Move-Issues @(30, 31, 32) $ms6

Remove-Item (Join-Path $dir '.gh-payload.json') -ErrorAction SilentlyContinue
Write-Output 'DONE'
