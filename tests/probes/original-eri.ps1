param([ValidateSet('eri', 'midi', 'kag', 'sli', 'kag-intro', 'transition', 'transition-alpha')][string]$Project = 'eri')
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
  throw 'The original SDK reference requires a GitHub-hosted Windows runner.'
}
$output = Join-Path $env:GITHUB_WORKSPACE 'out/verification/native-eri'
if ($Project -ne 'eri') { $output = Join-Path $output $Project }
$game = Join-Path $output 'game'
if (!(Test-Path (Join-Path $game 'startup.tjs'))) { throw "Missing prepared $Project reference project." }
$work = Join-Path $env:RUNNER_TEMP ('krkr2-eri-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $work | Out-Null
$pin = Get-Content tests/fixtures/native-reference/sdk.json -Raw | ConvertFrom-Json
$state = [ordered]@{ state = 'not-run'; commit = $env:GITHUB_SHA; attempt = $env:GITHUB_RUN_ATTEMPT
  run = $env:GITHUB_RUN_ID; image = $env:ImageVersion; timedOut = $false; exitCode = $null; error = $null }
$process = $null
try {
  # Both owned projects in this job use the same immutable SDK. Revalidate
  # cached bytes on every invocation; never reuse a partial network write.
  $archive = Join-Path $env:RUNNER_TEMP ('krkr2-sdk-' + $pin.archiveSha256 + '.zip')
  $state.archiveReused = Test-Path $archive
  if (!$state.archiveReused) {
    $download = Join-Path $work 'sdk-download.zip'
    Invoke-WebRequest -Uri $pin.url -OutFile $download
    if ((Get-Item $download).Length -ne $pin.archiveBytes -or (Get-FileHash $download).Hash.ToLowerInvariant() -cne $pin.archiveSha256) {
      throw 'Original SDK archive does not match its recorded size and SHA-256.'
    }
    Move-Item -LiteralPath $download -Destination $archive
  }
  if ((Get-Item $archive).Length -ne $pin.archiveBytes -or (Get-FileHash $archive).Hash.ToLowerInvariant() -cne $pin.archiveSha256) {
    throw 'Original SDK archive does not match its recorded size and SHA-256.'
  }
  $engine = Join-Path $work 'krkr.eXe'
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    $entry = $zip.GetEntry($pin.engineMember)
    if ($null -eq $entry) { throw 'Missing pinned KRKR2 engine member.' }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $engine)
  } finally { $zip.Dispose() }
  $state.engineSha256 = (Get-FileHash $engine).Hash.ToLowerInvariant()
  if ((Get-Item $engine).Length -ne $pin.engineBytes -or $state.engineSha256 -cne $pin.engineSha256) {
    throw 'Original SDK executable does not match its recorded size and SHA-256.'
  }
  $state.fileVersion = (Get-Item $engine).VersionInfo.FileVersion
  $process = Start-Process -FilePath $engine -WorkingDirectory $game -ArgumentList ('"' + $game + '" -forcelog=yes') -PassThru `
    -RedirectStandardOutput (Join-Path $output 'stdout.log') -RedirectStandardError (Join-Path $output 'stderr.log')
  $state.pid = $process.Id
  $null = $process.Handle
  if (!$process.WaitForExit(30000)) {
    $state.timedOut = $true
    throw "Original process timed out before completing the $Project controls."
  }
  $state.exitCode = $process.ExitCode
  if ($process.ExitCode -ne 0 -or !(Test-Path (Join-Path $game 'native-events.txt'))) {
    throw "Original process did not exit cleanly with $Project observations."
  }
  $state.state = 'observed'
} catch {
  $state.state = 'failed'
  $state.error = $_.Exception.ToString()
  throw
} finally {
  try {
    if ($null -ne $process -and !$process.HasExited) {
      $process.Kill()
      if (!$process.WaitForExit(5000)) { throw 'Owned SDK process did not exit during cleanup.' }
    }
  } finally {
    if ($null -ne $process) { $process.Dispose() }
    $state | ConvertTo-Json | Set-Content (Join-Path $output 'sdk-process.json') -Encoding utf8
  }
}
