$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
  throw 'Game registry comparison requires GitHub-hosted Windows.'
}
$output = Join-Path $env:GITHUB_WORKSPACE 'out/verification/native-eri/game-registry'
$game = Join-Path $output 'game'
New-Item -ItemType Directory -Force $game | Out-Null
# Both SDK and reg.exe use the 32-bit view. Only the temporary test key
# participates in the export, query and cleanup.
$key = 'Software\KrkrGameFixture-' + [Guid]::NewGuid().ToString('N')
$fullKey = "HKEY_CURRENT_USER\$key"
$registryTool = Join-Path $env:SystemRoot 'SysWOW64\reg.exe'
$inputFile = Join-Path $output 'input.reg'
$exportFile = Join-Path $output 'export.reg'
$report = [ordered]@{ commit=$env:GITHUB_SHA; run=$env:GITHUB_RUN_ID; key=$key; matched=$false; error=$null; cleaned=$false }
try {
  $body = @"
Windows Registry Editor Version 5.00

[$fullKey]
@="Default"
"Caption"="月の章"
"Score"=dword:ffffffff
"Target"=hex(2):25,00,47,00,41,00,4d,00,45,00,25,00,00,00
"Big"=hex(5):80,00,00,01
"Binary"=hex:77,88
"List"=hex(7):41,00,00,00,00,00
"@
  [IO.File]::WriteAllText($inputFile, $body + [Environment]::NewLine, [Text.Encoding]::Unicode)
  & $registryTool import $inputFile
  if ($LASTEXITCODE) { throw 'Windows could not import the game fixture.' }
  & $registryTool export $fullKey $exportFile /y
  if ($LASTEXITCODE) { throw 'Windows could not export the game fixture.' }
  $script = Get-Content 'tests/fixtures/registry/observe.tjs' -Raw -Encoding utf8
  [IO.File]::WriteAllText((Join-Path $game 'observe.tjs'), $script, [Text.Encoding]::Unicode)
  $startup = @'
var journal=["start"];
try {
  Scripts.execStorage("observe.tjs");
  journal.add(observeRegistry("KEY_HERE"));
  journal.add("done");
} catch(e) { journal.add("error|"+e.message); }
journal.save("native-events.txt");System.exit();
'@
  [IO.File]::WriteAllText((Join-Path $game 'startup.tjs'), $startup.Replace('KEY_HERE',$key.Replace('\','\\')), [Text.Encoding]::Unicode)
  & "$PSScriptRoot/original-eri.ps1" -Project game-registry
  $actual = @(Get-Content (Join-Path $game 'native-events.txt'))
  $expected = @('start','Default|月の章|Integer|4294967295|%GAME%|2147483649|4294967295|月の章|1|1|1|1|2|1|2','done')
  $report.rows = $actual
  $report.exportSha256 = (Get-FileHash $exportFile).Hash.ToLowerInvariant()
  if (($actual -join '|') -cne ($expected -join '|')) { throw 'Stock game registry lookup differs.' }
  $report.matched = $true
} catch { $report.error = $_.Exception.ToString(); throw }
finally {
  & $registryTool delete $fullKey /f
  $report.cleaned = $LASTEXITCODE -eq 0
  $report | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $output 'comparison.json') -Encoding utf8
  if (!$report.cleaned -and !$report.error) { throw 'Could not remove the temporary game key.' }
}
