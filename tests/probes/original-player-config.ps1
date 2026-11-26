$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
  throw 'External configuration reference requires a GitHub-hosted Windows runner.'
}
$output = Join-Path $env:GITHUB_WORKSPACE 'out/verification/native-player-config'
$inputs = Get-Content (Join-Path $output 'inputs.json') -Raw | ConvertFrom-Json
if ($inputs.commit -cne $env:GITHUB_SHA -or $inputs.run -cne $env:GITHUB_RUN_ID) { throw 'Input manifest identity differs.' }
$pin = Get-Content tests/fixtures/native-reference/sdk.json -Raw | ConvertFrom-Json
$work = Join-Path $env:RUNNER_TEMP ('krkr-config-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $work | Out-Null
$acquisition = [ordered]@{ commit = $env:GITHUB_SHA; run = $env:GITHUB_RUN_ID; state = 'not-acquired'; error = $null }
try {
  $archive = Join-Path $env:RUNNER_TEMP ('krkr2-sdk-' + $pin.archiveSha256 + '.zip')
  if (!(Test-Path $archive)) {
    $download = Join-Path $work 'sdk-download.zip'
    Invoke-WebRequest -Uri $pin.url -OutFile $download
    if ((Get-Item $download).Length -ne $pin.archiveBytes -or (Get-FileHash $download).Hash.ToLowerInvariant() -cne $pin.archiveSha256) {
      throw 'Pinned SDK archive size or digest differs.'
    }
    Move-Item -LiteralPath $download -Destination $archive
  }
  if ((Get-Item $archive).Length -ne $pin.archiveBytes -or (Get-FileHash $archive).Hash.ToLowerInvariant() -cne $pin.archiveSha256) {
    throw 'Pinned SDK archive size or digest differs.'
  }
  $original = Join-Path $work 'original.exe'
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    $entry = $zip.GetEntry($pin.engineMember)
    if ($null -eq $entry) { throw 'Pinned SDK engine member is missing.' }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $original)
  } finally { $zip.Dispose() }
  $engineSha256 = (Get-FileHash $original).Hash.ToLowerInvariant()
  if ((Get-Item $original).Length -ne $pin.engineBytes -or $engineSha256 -cne $pin.engineSha256) {
    throw 'Pinned SDK executable size or digest differs.'
  }
  $acquisition.state = 'verified'
  $acquisition.archiveSha256 = $pin.archiveSha256
  $acquisition.engineSha256 = $engineSha256
} catch {
  $acquisition.state = 'failed'; $acquisition.error = $_.Exception.ToString(); throw
} finally {
  $acquisition | ConvertTo-Json | Set-Content (Join-Path $output 'acquisition.json') -Encoding utf8
}

$failed = $false
foreach ($case in $inputs.cases) {
  $directory = Join-Path $output ('cases/' + $case.id)
  $app = Join-Path $work ($case.id + '/app')
  $game = Join-Path $app 'game'
  New-Item -ItemType Directory -Force $app | Out-Null
  $engine = Join-Path $app 'krkr.eXe'
  Copy-Item -LiteralPath $original -Destination $engine
  $state = [ordered]@{ state = 'not-run'; id = $case.id; commit = $env:GITHUB_SHA; run = $env:GITHUB_RUN_ID
    attempt = $env:GITHUB_RUN_ATTEMPT; image = $env:ImageVersion; engineSha256 = $engineSha256
    timedOut = $false; exitCode = $null; error = $null; cleanupError = $null; proofRelativePath = $null
    otherProofFiles = @(); arguments = @($case.args); expectedDataDirectory = $case.expectedDataDirectory }
  $process = $null
  try {
    foreach ($file in $case.files) {
      $source = Join-Path (Join-Path $directory 'input') $file.name
      if ((Get-Item $source).Length -ne $file.bytes -or (Get-FileHash $source).Hash.ToLowerInvariant() -cne $file.sha256) {
        throw 'An authored configuration input changed after preparation.'
      }
      $destination = Join-Path $app $file.name
      New-Item -ItemType Directory -Force (Split-Path $destination) | Out-Null
      Copy-Item -LiteralPath $source -Destination $destination
    }
    if ((Get-FileHash $engine).Hash.ToLowerInvariant() -cne $engineSha256) { throw 'Owned executable copy differs.' }
    # These literal arguments contain no shell metacharacter expansion: they
    # are passed directly to the owned executable, not to a shell command.
    $arguments = '"' + $game + '" -forcelog=yes'
    foreach ($argument in $case.args) {
      if ($argument -match '[\s"]') { throw 'Authored CLI argument unexpectedly requires quoting.' }
      $arguments += ' ' + $argument
    }
    $process = Start-Process -FilePath $engine -WorkingDirectory $game -ArgumentList $arguments -PassThru `
      -RedirectStandardOutput (Join-Path $directory 'stdout.log') -RedirectStandardError (Join-Path $directory 'stderr.log')
    $state.pid = $process.Id; $null = $process.Handle
    if (!$process.WaitForExit(30000)) { $state.timedOut = $true; throw 'Original configuration process timed out.' }
    $state.exitCode = $process.ExitCode
    if ($process.ExitCode -ne 0 -or !(Test-Path (Join-Path $game 'native-events.txt'))) {
      throw 'Original configuration process did not produce a clean terminal journal.'
    }
    $state.state = 'observed'
  } catch {
    $state.state = 'failed'; $state.error = $_.Exception.ToString(); $failed = $true
  } finally {
    try {
      if ($null -ne $process -and !$process.HasExited) {
        $process.Kill()
        if (!$process.WaitForExit(5000)) { throw 'Owned configuration process survived cleanup.' }
      }
    } catch { $state.cleanupError = $_.Exception.ToString(); $state.state = 'failed'; $failed = $true }
    finally {
      if ($null -ne $process) { $process.Dispose() }
      $journal = Join-Path $game 'native-events.txt'
      if (Test-Path $journal) { Copy-Item -LiteralPath $journal -Destination (Join-Path $directory 'native-events.txt') }
      $proof = [IO.Path]::GetFullPath((Join-Path $app ($case.expectedDataDirectory + '/config-proof.txt')))
      if (Test-Path $proof) {
        Copy-Item -LiteralPath $proof -Destination (Join-Path $directory 'config-proof.txt')
        $state.proofRelativePath = $case.expectedDataDirectory + '/config-proof.txt'
      }
      $state.otherProofFiles = @(Get-ChildItem -LiteralPath $app -Filter 'config-proof.txt' -File -Recurse |
        Where-Object { $_.FullName -ine $proof } | ForEach-Object { $_.FullName.Substring($app.Length + 1).Replace('\', '/') })
      $logs = Join-Path $directory 'original-logs'
      foreach ($log in @(Get-ChildItem -LiteralPath $app -Filter 'krkr.console.log' -File -Recurse)) {
        $relative = $log.FullName.Substring($app.Length + 1)
        $target = Join-Path $logs $relative
        New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
        Copy-Item -LiteralPath $log.FullName -Destination $target
      }
      $state | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $directory 'sdk-process.json') -Encoding utf8
    }
  }
}
if ($failed) { throw 'One or more original external-configuration observations failed; original records retained.' }
