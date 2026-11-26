param([Parameter(Mandatory)][Diagnostics.Process]$Process, [Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
  throw 'Original mouse input requires GitHub-hosted Windows.'
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OriginalMouseInput {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Mouse { public int X,Y; public uint Data,Flags,Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint Type; public Mouse Value; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
  [DllImport("user32.dll")] public static extern uint GetDoubleClickTime();
  [DllImport("user32.dll")] public static extern uint SendInput(uint count,Input[] input,int size);
  public static uint Button(uint flags) {
    var item=new Input { Type=0, Value=new Mouse { Flags=flags } };
    return SendInput(1,new[]{item},Marshal.SizeOf(typeof(Input)));
  }
}
'@
$journal = [Collections.Generic.List[object]]::new()
$state = [ordered]@{ commit=$env:GITHUB_SHA; complete=$false; controlledSendInput=$true; physicalHardwareClaim=$false;
  pid=$Process.Id; error=$null; cleanupError=$null; events=$journal }
$pressed = $false
function Assert-OwnedForeground {
  [uint32]$owner = 0
  [void][OriginalMouseInput]::GetWindowThreadProcessId([OriginalMouseInput]::GetForegroundWindow(), [ref]$owner)
  if ($owner -ne $Process.Id) { throw 'The original game no longer owns foreground input.' }
}
function Set-OwnedPoint([int]$x, [int]$y) {
  Assert-OwnedForeground
  if (![OriginalMouseInput]::SetCursorPos($script:origin.X+$x,$script:origin.Y+$y)) { throw 'Could not position the owned game cursor.' }
  $journal.Add([ordered]@{ kind='point'; x=$x; y=$y })
}
function Send-OwnedButton([bool]$down) {
  Assert-OwnedForeground
  $flags = if ($down) { [uint32]2 } else { [uint32]4 }
  $sent = [OriginalMouseInput]::Button($flags)
  $journal.Add([ordered]@{ kind= $(if ($down) { 'down' } else { 'up' }); sent=$sent })
  if ($sent -ne 1) { throw 'The controlled mouse input was not accepted.' }
  $script:pressed = $down
}
try {
  $ready = Join-Path $Output 'game/native-ready.txt'
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (!(Test-Path -LiteralPath $ready)) {
    if ($Process.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Original game did not publish its owned mouse window.' }
    Start-Sleep -Milliseconds 20
  }
  # The game uses its public setCursorPos(0,0) to publish the actual PaintBox
  # origin, avoiding assumptions about VCL borders, menus or display scaling.
  $values = [IO.File]::ReadAllLines($ready)
  if ($values.Count -ne 3 -or $values[1] -cne '0' -or $values[2] -cne '0') { throw 'Original PaintBox cursor origin was not observed.' }
  $window = [IntPtr]([int64]$values[0]); [uint32]$owner = 0
  [void][OriginalMouseInput]::GetWindowThreadProcessId($window,[ref]$owner)
  if ($owner -ne $Process.Id) { throw 'Published Window does not belong to the owned SDK process.' }
  [void][OriginalMouseInput]::SetForegroundWindow($window)
  Assert-OwnedForeground
  $script:origin = [OriginalMouseInput+Point]::new()
  if (![OriginalMouseInput]::GetCursorPos([ref]$script:origin)) { throw 'Could not read PaintBox screen origin.' }
  [void][OriginalMouseInput]::GetWindowThreadProcessId([OriginalMouseInput]::WindowFromPoint($script:origin),[ref]$owner)
  if ($owner -ne $Process.Id) { throw 'PaintBox origin does not hit the owned game.' }
  $state.origin = @{x=$script:origin.X;y=$script:origin.Y}
  $state.doubleClickTime = [OriginalMouseInput]::GetDoubleClickTime()
  foreach ($second in @(@(40,30),@(41,31))) {
    Set-OwnedPoint 40 30
    Send-OwnedButton $true; Start-Sleep -Milliseconds 20; Send-OwnedButton $false
    Start-Sleep -Milliseconds 30
    Set-OwnedPoint $second[0] $second[1]
    Send-OwnedButton $true; Start-Sleep -Milliseconds 20
    Set-OwnedPoint 240 90
    Send-OwnedButton $false
    # Separate the two authored sequences by the actual system preference.
    if ($second[0] -eq 40) { Start-Sleep -Milliseconds ([int]$state.doubleClickTime+80) }
  }
  $state.complete = $true
} catch { $state.error=$_.Exception.ToString(); throw }
finally {
  if ($pressed) {
    try { if ([OriginalMouseInput]::Button(4) -ne 1) { throw 'Could not release the controlled button.' } }
    catch { $state.cleanupError=$_.Exception.ToString(); $state.complete=$false }
  }
  $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Output 'input-observation.json') -Encoding utf8
}
