# Data collection/conversion for original-runtime.yml only. Never run locally.
# The sole native call is read-only GetSysColor(0..24); this file neither starts
# nor controls processes, sends input, changes colors, or loads an engine plugin.
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
  throw 'Original system-color observations require a GitHub-hosted Windows runner.'
}

function Write-OriginalSystemColorJson {
  param(
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$FileName,
    [Parameter(Mandatory)][object]$Value
  )
  $path = Join-Path $OutputDirectory $FileName
  $json = $Value | ConvertTo-Json -Depth 24
  # Write first so a schema/converter failure still leaves its exact output.
  [IO.File]::WriteAllText($path, $json + "`n", [Text.UTF8Encoding]::new($false))
  $schema = Join-Path $OutputDirectory 'system-colors.schema.json'
  if (-not (Test-Json -Json $json -SchemaFile $schema -ErrorAction Stop)) {
    throw ('Original system-color artifact does not match its schema: ' + $FileName)
  }
}

function Read-OriginalSystemPalette {
  param([Parameter(Mandatory)][string]$OutputDirectory)
  if (-not ('OriginalSystemColorsNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class OriginalSystemColorsNative {
    [DllImport("user32.dll", ExactSpelling = true)]
    public static extern uint GetSysColor(int index);
}
'@
  }
  $names = @(
    'clScrollBar', 'clBackground', 'clActiveCaption', 'clInactiveCaption',
    'clMenu', 'clWindow', 'clWindowFrame', 'clMenuText', 'clWindowText',
    'clCaptionText', 'clActiveBorder', 'clInactiveBorder', 'clAppWorkSpace',
    'clHighlight', 'clHighlightText', 'clBtnFace', 'clBtnShadow', 'clGrayText',
    'clBtnText', 'clInactiveCaptionText', 'clBtnHighlight', 'cl3DDkShadow',
    'cl3DLight', 'clInfoText', 'clInfoBk'
  )
  $entries = [Collections.Generic.List[object]]::new()
  for ($index = 0; $index -lt $names.Count; $index++) {
    [uint32]$raw = [OriginalSystemColorsNative]::GetSysColor($index)
    [uint32]$red = $raw -band 0xff
    [uint32]$green = ($raw -shr 8) -band 0xff
    [uint32]$blue = ($raw -shr 16) -band 0xff
    [uint32]$rgb = ($red -shl 16) -bor ($green -shl 8) -bor $blue
    $entries.Add([ordered]@{
      index = $index; constantName = $names[$index]
      colorrefBgrDecimal = [long]$raw; colorrefBgrHex = ('0x{0:x8}' -f $raw)
      rgbDecimal = [long]$rgb; rgbHex = ('0x{0:x6}' -f $rgb)
      red = [int]$red; green = [int]$green; blue = [int]$blue
    })
  }
  $report = [ordered]@{
    schema = 1; kind = 'original-system-colors-palette'; state = 'observed'
    scope = 'Read-only GetSysColor on this hosted Windows runner; not a fixed universal palette and not an SDK/VCL behavior claim.'
    api = 'https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getsyscolor'
    capturedAt = [DateTime]::UtcNow.ToString('o')
    run = [ordered]@{
      runId = $env:GITHUB_RUN_ID; attempt = $env:GITHUB_RUN_ATTEMPT
      commit = $env:GITHUB_SHA; runner = $env:NATIVE_OS; scenario = $env:NATIVE_SCENARIO
    }
    environment = [ordered]@{
      OSDescription = [Runtime.InteropServices.RuntimeInformation]::OSDescription
      OSVersion = [Environment]::OSVersion.VersionString
      ImageOS = $env:ImageOS; ImageVersion = $env:ImageVersion
      processArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
      processArchitectureScope = 'PowerShell GetSysColor caller, not an SDK binary architecture assertion'
    }
    entries = @($entries.ToArray())
  }
  Write-OriginalSystemColorJson -OutputDirectory $OutputDirectory -FileName 'system-palette.json' -Value $report
}

function Convert-OriginalSystemColorObservations {
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
      throw 'Case manifest contains an invalid or duplicate id.'
    }
  }
  if ($manifest.schema -ne 1 -or $manifest.suite -cne 'system-colors' -or $requested.Count -eq 0) {
    throw 'Unexpected system-color case manifest.'
  }
  $records = [Collections.Generic.List[object]]::new()
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $duplicates = [Collections.Generic.List[string]]::new()
  $unexpected = [Collections.Generic.List[string]]::new()
  $parseErrors = [Collections.Generic.List[string]]::new()
  $fatalErrors = [Collections.Generic.List[string]]::new()
  $versions = [Collections.Generic.List[string]]::new()
  $completionCount = 0; $startCount = 0; $scenarioCount = 0; $modeCount = 0
  $eventsPresent = Test-Path -LiteralPath $EventsPath -PathType Leaf
  $eventHash = $null
  $lines = @()
  if ($eventsPresent) {
    $eventHash = (Get-FileHash -LiteralPath $EventsPath -Algorithm SHA256).Hash.ToLowerInvariant()
    # ReadAllLines detects the native Array.save BOM; preserve the source bytes too.
    $lines = @([IO.File]::ReadAllLines($EventsPath))
  }
  for ($lineIndex = 0; $lineIndex -lt $lines.Count; $lineIndex++) {
    $line = $lines[$lineIndex]
    if ($line -ceq 'start') { $startCount++; continue }
    if ($line -ceq 'scenario:system-colors') { $scenarioCount++; continue }
    if ($line -ceq 'mode:source') { $modeCount++; continue }
    if ($line.StartsWith('version:', [StringComparison]::Ordinal)) {
      $versions.Add($line.Substring(8)); continue
    }
    if ($line -ceq 'observations-complete') { $completionCount++; continue }
    if ($line.StartsWith('error:', [StringComparison]::Ordinal)) {
      $fatalErrors.Add($line.Substring(6)); continue
    }
    if (-not $line.StartsWith('case|', [StringComparison]::Ordinal)) {
      $parseErrors.Add(('Unrecognized native event at line ' + ($lineIndex + 1))); continue
    }
    # Only the final escaped error field may contain '|'. Never decode String.escape.
    $parts = $line.Split([char[]]'|', 9, [StringSplitOptions]::None)
    if ($parts.Count -ne 9) {
      $parseErrors.Add(('Malformed case record at line ' + ($lineIndex + 1))); continue
    }
    $caseId = $parts[1]
    if (-not $requested.Contains($caseId)) { $unexpected.Add($caseId) }
    if (-not $seen.Add($caseId)) { $duplicates.Add($caseId) }
    [int]$effects = 0
    if ($parts[2] -cnotin @('returned', 'error') -or
        $parts[7] -cnotmatch '^[0-9]+$' -or
        -not [int]::TryParse($parts[7], [ref]$effects)) {
      $parseErrors.Add(('Invalid outcome/effect count at line ' + ($lineIndex + 1))); continue
    }
    if (($parts[2] -ceq 'returned' -and $parts[8].Length -ne 0) -or
        ($parts[2] -ceq 'error' -and ($parts[5].Length -ne 0 -or $parts[6].Length -ne 0))) {
      $parseErrors.Add(('Mixed return/error payload at line ' + ($lineIndex + 1))); continue
    }
    $records.Add([ordered]@{
      caseId = $caseId; outcome = $parts[2]
      inputType = $parts[3]; inputText = $parts[4]
      resultType = $parts[5]; resultText = $parts[6]
      effectCount = $effects; errorMessageEscaped = $parts[8]
      rawLineNumber = $lineIndex + 1
    })
  }
  $missing = @($requested | Where-Object { -not $seen.Contains($_) } | Sort-Object)
  $complete = $eventsPresent -and $startCount -eq 1 -and $scenarioCount -eq 1 -and
    $modeCount -eq 1 -and $versions.Count -eq 1 -and $completionCount -eq 1 -and
    $records.Count -eq $requested.Count -and $missing.Count -eq 0 -and
    $duplicates.Count -eq 0 -and $unexpected.Count -eq 0 -and
    $parseErrors.Count -eq 0 -and $fatalErrors.Count -eq 0 -and
    $null -ne $Status['exitCode'] -and $Status['exitCode'] -eq 0 -and
    -not $Status['timedOut'] -and $Status['state'] -cnotin @('failed', 'timed-out')
  $state = if ($complete) { 'observed' } elseif ($eventsPresent) { 'incomplete' } else { 'not-run' }
  $report = [ordered]@{
    schema = 1; kind = 'original-system-colors-observations'; state = $state
    scope = 'Native values/errors only; completion is not conformance to source expectations, a Web result, or proof of the SDK exact source/VCL revision.'
    executionMode = 'source'; capturedAt = [DateTime]::UtcNow.ToString('o')
    run = [ordered]@{
      runId = $Status['runId']; attempt = $Status['attempt']; commit = $Status['commit']
      runner = $Status['runner']; scenario = $Status['scenario']
    }
    environment = $Status['environment']; sourceReference = $manifest.sourceReference
    engine = $Status['engine']; scriptVersions = @($versions.ToArray())
    execution = [ordered]@{
      processId = $Status['processId']; exitCode = $Status['exitCode']
      timedOut = [bool]$Status['timedOut']; processDeadlineMs = $Status['processDeadlineMs']
      workflowStateAtConversion = $Status['state']; workflowStageAtConversion = $Status['stage']
      workflowErrorAtConversion = $Status['error']
    }
    evidence = [ordered]@{
      eventsFile = 'native-events.txt'; eventsPresent = [bool]$eventsPresent; eventsSha256 = $eventHash
      generatedScriptSha256 = $Status['scriptSha256']
      inputs = $Status['systemColorsInputs']
    }
    completeness = [ordered]@{
      requestedCaseCount = $requested.Count; recordedCaseCount = $records.Count
      startCount = $startCount; scenarioCount = $scenarioCount; modeCount = $modeCount
      completionMarkerCount = $completionCount
      missingCaseIds = @($missing); duplicateCaseIds = @($duplicates.ToArray())
      unexpectedCaseIds = @($unexpected.ToArray()); parseErrors = @($parseErrors.ToArray())
      fatalErrorsEscaped = @($fatalErrors.ToArray())
    }
    records = @($records.ToArray())
  }
  # A finally retry must not overwrite the exact first conversion/schema failure.
  $reportFile = if ($AllowIncomplete) { 'system-colors-observations.partial.json' } else { 'system-colors-observations.json' }
  Write-OriginalSystemColorJson -OutputDirectory $OutputDirectory -FileName $reportFile -Value $report
  if (-not $complete -and -not $AllowIncomplete) {
    throw 'Original system-color records are incomplete; see preserved structured evidence and native events.'
  }
}
