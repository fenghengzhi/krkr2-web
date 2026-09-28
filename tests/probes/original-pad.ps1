# Source-only Pad observation collection. Never execute on a local machine.
# Read-only ACP/system DPI metadata; no windows, input, hooks, or SDK injection.
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
  throw 'Original Pad observations require a GitHub-hosted Windows runner.'
}

function Read-OriginalPadHostMetadata {
  if (-not ('OriginalPadHost' -as [type])) {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class OriginalPadHost {
    [DllImport("kernel32.dll", ExactSpelling = true)]
    public static extern uint GetACP();
    [DllImport("user32.dll", ExactSpelling = true)]
    public static extern uint GetDpiForSystem();
}
'@
  }
  return [ordered]@{
    ansiCodePage = [OriginalPadHost]::GetACP()
    hostSystemDpi = [OriginalPadHost]::GetDpiForSystem()
    scope = 'Read-only ACP and system DPI from the PowerShell host; DPI is not proof of the SDK process awareness, VCL scaling, font availability or font rendering.'
  }
}

function Convert-PadUnitList {
  param([AllowEmptyString()][string]$Text)
  $units = [Collections.Generic.List[int]]::new()
  if ($Text.Length -gt 0) {
    foreach ($part in $Text.Split(',')) {
      [int]$unit = 0
      if ($part -cnotmatch '^(0|[1-9][0-9]{0,4})$' -or -not [int]::TryParse($part, [ref]$unit) -or $unit -gt 65535) {
        throw 'Invalid UTF-16 code unit list.'
      }
      $units.Add($unit)
    }
  }
  return ,$units.ToArray()
}

function Convert-OriginalPadObservations {
  param(
    [Parameter(Mandatory)][string]$EventsPath,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$CasesPath,
    [Parameter(Mandatory)][Collections.IDictionary]$Status,
    [switch]$AllowIncomplete
  )
  $manifest = Get-Content -LiteralPath $CasesPath -Raw -Encoding utf8 | ConvertFrom-Json
  $requested = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($case in $manifest.cases) {
    if ([string]$case.id -cnotmatch '^[A-Za-z0-9-]+$' -or -not $requested.Add([string]$case.id)) {
      throw 'Pad case manifest has an invalid or duplicate id.'
    }
  }
  if ($manifest.schema -ne 1 -or $manifest.suite -cne 'pad' -or $manifest.executionMode -cne 'source' -or $requested.Count -eq 0) {
    throw 'Unexpected Pad case manifest.'
  }
  $records = [Collections.Generic.List[object]]::new()
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $duplicates = [Collections.Generic.List[string]]::new()
  $unexpected = [Collections.Generic.List[string]]::new()
  $parseErrors = [Collections.Generic.List[string]]::new()
  $fatalErrors = [Collections.Generic.List[string]]::new()
  $versions = [Collections.Generic.List[string]]::new()
  $startCount = 0; $scenarioCount = 0; $modeCount = 0; $completionCount = 0
  $eventsPresent = Test-Path -LiteralPath $EventsPath -PathType Leaf
  $eventHash = $null; $lines = @()
  if ($eventsPresent) {
    $eventHash = (Get-FileHash -LiteralPath $EventsPath -Algorithm SHA256).Hash.ToLowerInvariant()
    # Original Array.save carries a BOM. Preserve its bytes; ReadAllLines detects it.
    $lines = @([IO.File]::ReadAllLines($EventsPath))
  }
  for ($index = 0; $index -lt $lines.Count; $index++) {
    $line = $lines[$index]
    if ($line -ceq 'start') { $startCount++; continue }
    if ($line -ceq 'scenario:pad') { $scenarioCount++; continue }
    if ($line -ceq 'mode:source') { $modeCount++; continue }
    if ($line -ceq 'observations-complete') { $completionCount++; continue }
    if ($line.StartsWith('version:', [StringComparison]::Ordinal)) { $versions.Add($line.Substring(8)); continue }
    if ($line.StartsWith('error:', [StringComparison]::Ordinal)) { $fatalErrors.Add($line.Substring(6)); continue }
    $parts = $line.Split('|')
    if ($parts.Count -ne 8 -or $parts[0] -cne 'case') {
      $parseErrors.Add('Unrecognized or malformed native event at line ' + ($index + 1)); continue
    }
    $id = $parts[1]
    if (-not $requested.Contains($id)) { $unexpected.Add($id) }
    if (-not $seen.Add($id)) { $duplicates.Add($id) }
    try {
      if ($parts[2] -cnotin @('returned', 'error') -or $parts[5] -cnotin @('void', 'String', 'Integer', 'Real')) {
        throw 'Invalid outcome or input type.'
      }
      if ($parts[2] -ceq 'returned') {
        if ($parts[3] -cnotin @('void', 'String', 'Integer', 'Real') -or $parts[7].Length -ne 0) {
          throw 'Invalid return payload.'
        }
      } elseif ($parts[3].Length -ne 0 -or $parts[4].Length -ne 0) {
        throw 'Mixed return and error payload.'
      }
      $resultUnits = Convert-PadUnitList $parts[4]
      $inputUnits = Convert-PadUnitList $parts[6]
      $errorUnits = Convert-PadUnitList $parts[7]
      $records.Add([ordered]@{
        caseId = $id; outcome = $parts[2]; resultType = $parts[3]
        resultTextUtf16Units = @($resultUnits)
        inputType = $parts[5]; inputTextUtf16Units = @($inputUnits)
        errorMessageUtf16Units = @($errorUnits); rawLineNumber = $index + 1
      })
    } catch { $parseErrors.Add('Line ' + ($index + 1) + ': ' + $_.Exception.Message) }
  }
  $missing = @($requested | Where-Object { -not $seen.Contains($_) } | Sort-Object)
  $returnedCount = @($records | Where-Object { $_.outcome -ceq 'returned' }).Count
  $errorCount = @($records | Where-Object { $_.outcome -ceq 'error' }).Count
  $complete = $eventsPresent -and $startCount -eq 1 -and $scenarioCount -eq 1 -and
    $modeCount -eq 1 -and $versions.Count -eq 1 -and $completionCount -eq 1 -and
    $records.Count -eq $requested.Count -and $missing.Count -eq 0 -and
    $duplicates.Count -eq 0 -and $unexpected.Count -eq 0 -and
    $parseErrors.Count -eq 0 -and $fatalErrors.Count -eq 0 -and
    $null -ne $Status['exitCode'] -and $Status['exitCode'] -eq 0 -and
    -not $Status['timedOut'] -and $Status['state'] -cnotin @('failed', 'timed-out')
  $state = if ($complete) { 'observed' } elseif ($eventsPresent) { 'incomplete' } else { 'not-run' }
  $report = [ordered]@{
    schema = 1; kind = 'original-pad-observations'; state = $state; executionMode = 'source'
    scope = 'Actual scalar values and errors only. Observed is complete collection, not conformance, Web correctness, UI/rendering proof, or the exact SDK source/VCL revision.'
    capturedAt = [DateTime]::UtcNow.ToString('o')
    run = [ordered]@{
      runId = $Status['runId']; attempt = $Status['attempt']; commit = $Status['commit']
      runner = $Status['runner']; scenario = $Status['scenario']
    }
    environment = $Status['environment']; hostMetadata = $Status['padHost']
    sourceReference = $manifest.sourceReference; engine = $Status['engine']
    scriptVersions = @($versions.ToArray())
    execution = [ordered]@{
      processId = $Status['processId']; exitCode = $Status['exitCode']; timedOut = [bool]$Status['timedOut']
      processDeadlineMs = $Status['processDeadlineMs']; workflowStateAtConversion = $Status['state']
      workflowStageAtConversion = $Status['stage']; workflowErrorAtConversion = $Status['error']
    }
    evidence = [ordered]@{
      eventsFile = 'native-events.txt'; eventsPresent = [bool]$eventsPresent; eventsSha256 = $eventHash
      generatedScriptSha256 = $Status['scriptSha256']; inputs = $Status['padInputs']
    }
    completeness = [ordered]@{
      requestedCaseCount = $requested.Count; recordedCaseCount = $records.Count
      returnedCount = $returnedCount; errorCount = $errorCount
      startCount = $startCount; scenarioCount = $scenarioCount; modeCount = $modeCount
      completionMarkerCount = $completionCount
      missingCaseIds = @($missing); duplicateCaseIds = @($duplicates.ToArray())
      unexpectedCaseIds = @($unexpected.ToArray()); parseErrors = @($parseErrors.ToArray())
      fatalErrors = @($fatalErrors.ToArray())
    }
    records = @($records.ToArray())
  }
  # Preserve first conversion output even if schema or completeness validation fails.
  # The workflow's finally conversion uses a distinct partial file.
  $file = if ($AllowIncomplete) { 'pad-observations.partial.json' } else { 'pad-observations.json' }
  $json = $report | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText((Join-Path $OutputDirectory $file), $json + "`n", [Text.UTF8Encoding]::new($false))
  if (-not (Test-Json -Json $json -SchemaFile (Join-Path $OutputDirectory 'pad.schema.json') -ErrorAction Stop)) {
    throw 'Pad observation artifact does not match its schema.'
  }
  if (-not $complete -and -not $AllowIncomplete) {
    throw 'Original Pad observations are incomplete; preserve raw and partial evidence.'
  }
}
