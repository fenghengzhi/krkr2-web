$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
  throw 'Original termination observations require a GitHub-hosted Windows runner.'
}
$output = Join-Path $env:GITHUB_WORKSPACE 'out/verification/original-termination'
New-Item -ItemType Directory -Force $output | Out-Null
$root = Join-Path $env:RUNNER_TEMP ('krkr2-termination-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $root | Out-Null
$summary = [ordered]@{
  schema = 1; state = 'not-run'; runId = $env:GITHUB_RUN_ID; attempt = $env:GITHUB_RUN_ATTEMPT
  commit = $env:GITHUB_SHA; runner = $env:NATIVE_OS; scope = 'Original pinned SDK observations; not a Web equivalence verdict'
  globalInputUsed = $false; pluginsLoadedByFixture = $false; processDeadlineMs = 20000
  sourceCommitScope = 'The distributed VCL binary is pinned independently of the static 2.32stable source commit.'
  cases = @(); error = $null
}
try {
  $pin = Get-Content tests/fixtures/native-reference/sdk.json -Raw | ConvertFrom-Json
  Copy-Item tests/fixtures/native-reference/sdk.json (Join-Path $output 'sdk.json')
  Copy-Item tests/fixtures/native-reference/system-termination.tjs (Join-Path $output 'fixture.tjs')
  Copy-Item tests/probes/original-termination.ps1 (Join-Path $output 'driver.ps1')
  $summary.fixtureSha256 = (Get-FileHash tests/fixtures/native-reference/system-termination.tjs -Algorithm SHA256).Hash.ToLowerInvariant()
  $summary.driverSha256 = (Get-FileHash tests/probes/original-termination.ps1 -Algorithm SHA256).Hash.ToLowerInvariant()
  $archive = Join-Path $root 'sdk.zip'
  Invoke-WebRequest -Uri $pin.url -OutFile $archive
  if ((Get-Item $archive).Length -ne $pin.archiveBytes -or (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.archiveSha256) {
    throw 'Original SDK archive differs from the preserved bytes.'
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  $engine = Join-Path $root 'krkr.eXe'
  try {
    $entry = $zip.GetEntry($pin.engineMember)
    if ($null -eq $entry) { throw 'Pinned engine member is missing.' }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $engine)
  } finally { $zip.Dispose() }
  if ((Get-Item $engine).Length -ne $pin.engineBytes -or (Get-FileHash $engine -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.engineSha256) {
    throw 'Original engine differs from the pinned SDK member.'
  }
  $summary.engine = [ordered]@{ bytes = $pin.engineBytes; sha256 = $pin.engineSha256; fileVersion = (Get-Item $engine).VersionInfo.FileVersion }
  $fixture = Get-Content tests/fixtures/native-reference/system-termination.tjs -Raw -Encoding utf8
  $scenarios = @('plain-terminate', 'plain-exit', 'timer-terminate', 'timer-window-modal', 'terminate-before-modal', 'timer-inform', 'timer-input', 'timer-menu')
  foreach ($scenario in $scenarios) {
    $work = Join-Path $root $scenario
    $caseOutput = Join-Path $output $scenario
    New-Item -ItemType Directory $work, $caseOutput | Out-Null
    $status = [ordered]@{ scenario = $scenario; state = 'not-run'; timedOut = $false; exitCode = $null; elapsedMs = $null; events = @(); error = $null; cleanupError = $null }
    $process = $null
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
      $startup = Join-Path $work 'startup.tjs'
      [IO.File]::WriteAllText($startup, $fixture.Replace('__NATIVE_SCENARIO__', $scenario), [Text.UnicodeEncoding]::new($false, $true))
      Copy-Item $startup (Join-Path $caseOutput 'startup.tjs')
      $status.scriptSha256 = (Get-FileHash $startup -Algorithm SHA256).Hash.ToLowerInvariant()
      # Explicit project folder: current working directory alone is not an SDK
      # project selection rule. Each process only receives its owned directory.
      $arguments = '"' + $work + '" -forcelog=yes'
      $status.arguments = $arguments
      $process = Start-Process -FilePath $engine -WorkingDirectory $work -ArgumentList $arguments -PassThru `
        -RedirectStandardOutput (Join-Path $caseOutput 'stdout.log') -RedirectStandardError (Join-Path $caseOutput 'stderr.log')
      $status.processId = $process.Id
      $null = $process.Handle
      if (-not $process.WaitForExit(20000)) {
        $status.timedOut = $true
        throw 'Original engine exceeded the owned-process deadline; modal ordering is unobserved.'
      }
      $status.exitCode = $process.ExitCode
      $eventsFile = Join-Path $work 'native-events.txt'
      if (-not (Test-Path $eventsFile)) { throw 'Original script produced no observation file.' }
      $status.events = @([IO.File]::ReadAllLines($eventsFile))
      $invocation = if ($scenario -ceq 'plain-exit') { 'exit-call' } else { 'terminate-call' }
      if ($process.ExitCode -ne 0 -or $status.events -cnotcontains $invocation -or ($status.events | Where-Object { $_.StartsWith('error:') })) {
        throw 'Original process did not reach the requested invocation and exit cleanly.'
      }
      # After-call/catch/modal-return rows are evidence, NOT preselected pass
      # expectations. A timeout never establishes negative native semantics.
      $status.state = 'observed'
    } catch {
      $status.state = 'failed'
      $status.error = $_.Exception.ToString()
    } finally {
      try {
        if ($null -ne $process -and -not $process.HasExited) {
          try { $process.Kill() }
          catch { if (-not $process.HasExited) { throw } }
          if (-not $process.WaitForExit(5000)) { throw 'Owned engine did not exit after forced cleanup.' }
        }
      } catch { $status.cleanupError = $_.Exception.ToString(); $status.state = 'failed' }
      foreach ($file in Get-ChildItem -LiteralPath $work -File -ErrorAction SilentlyContinue) {
        if ($file.Extension -in @('.txt', '.log')) { Copy-Item $file.FullName (Join-Path $caseOutput $file.Name) -Force }
      }
      $eventsFile = Join-Path $work 'native-events.txt'
      if (Test-Path $eventsFile) { $status.events = @([IO.File]::ReadAllLines($eventsFile)) }
      $status.elapsedMs = $clock.ElapsedMilliseconds
      $status | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $caseOutput 'status.json') -Encoding utf8
      $summary.cases += $status
      if ($null -ne $process) { $process.Dispose() }
    }
  }
  if ($summary.cases.Count -ne 8 -or ($summary.cases | Where-Object { $_.state -cne 'observed' }).Count -ne 0) {
    throw 'One or more original termination scenarios failed; consult retained per-process evidence.'
  }
  $summary.state = 'observed'
} catch {
  $summary.state = 'failed'
  $summary.error = $_.Exception.ToString()
  throw
} finally {
  $summary.completedAt = [DateTime]::UtcNow.ToString('o')
  $summary | ConvertTo-Json -Depth 12 | Set-Content (Join-Path $output 'summary.json') -Encoding utf8
}
