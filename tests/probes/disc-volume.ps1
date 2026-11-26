$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
  throw 'Disc-volume comparison requires GitHub-hosted Windows.'
}
$fixtures = Join-Path $env:GITHUB_WORKSPACE 'out/verification/disc-volumes'
$output = Join-Path $env:GITHUB_WORKSPACE 'out/verification/native-eri/disc-volume'
$game = Join-Path $output 'game'
New-Item -ItemType Directory -Force $game | Out-Null
$mounted = @()
$volumes = @()
$cleanup = @()
$report = [ordered]@{ commit = $env:GITHUB_SHA; run = $env:GITHUB_RUN_ID; volumes = @(); matched = $false; error = $null }
try {
  $names = @{ 'plain.iso' = 'KRKR_PLAIN'; 'joliet.iso' = 'KIRIKIRI_DISC'; 'story.iso' = 'KRKR_STORY' }
  $sums = @(Get-Content (Join-Path $fixtures 'SHA256SUMS'))
  foreach ($name in 'plain.iso','joliet.iso','story.iso') {
    $image = Join-Path $fixtures $name
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $image).Hash.ToLowerInvariant()
    if ($sums -cnotcontains "$hash  $name") { throw "Unexpected ISO digest for $name" }
    $disc = Mount-DiskImage -ImagePath $image -StorageType ISO -Access ReadOnly -PassThru
    $mounted += $image
    $volume = $disc | Get-Volume -ErrorAction SilentlyContinue
    for ($attempt = 0; $attempt -lt 20 -and !$volume.DriveLetter; $attempt++) {
      Start-Sleep -Milliseconds 250
      $volume = Get-DiskImage -ImagePath $image | Get-Volume -ErrorAction SilentlyContinue
    }
    if (!$volume.DriveLetter -or $volume.FileSystemLabel -cne $names[$name]) { throw "Windows did not mount $name with its authored label" }
    $volumes += [ordered]@{ name = $name; sha256 = $hash; label = $volume.FileSystemLabel; drive = [string]$volume.DriveLetter }
  }
  $report.volumes = $volumes
  $root = "$($volumes[2].drive):\"
  if ([IO.File]::ReadAllText((Join-Path $root 'Routes\開幕.tjs')) -cne '6*7') { throw 'Unexpected Joliet script contents on Windows' }
  $book = [IO.Compression.ZipFile]::OpenRead((Join-Path $root 'Books\Scenes.zip'))
  try {
    $bonus = [IO.StreamReader]::new($book.GetEntry('Bonus.tjs').Open())
    try { if ($bonus.ReadToEnd() -cne '9*9') { throw 'Unexpected nested ZIP contents on Windows' } }
    finally { $bonus.Dispose() }
  } finally { $book.Dispose() }
  [IO.File]::WriteAllText((Join-Path $game 'lookup.tjs'), @'
var extras=0,missing=0,conversion=0;
function extra(){extras++;return <% 10 %>;}
try{Storages.searchCD();}catch(e){missing++;}
try{var badCount=Storages.searchCD();}catch(e){missing++;}
Storages.searchCD(<% 01 %>,extra());
try{var bad=Storages.searchCD(<% 01 %>,extra());}catch(e){conversion++;}
var contract=[missing,conversion,extras].join("|");
var driveResult=[Storages.searchCD("krkr_Plain"),Storages.searchCD("kiriKiri_disc"),Storages.searchCD("KRKR_ABSENT_427")].join("|");
var storyDrive=Storages.searchCD("krkr_story"),chapter=storyDrive+":/Routes/Moon Finale.tjs";
var full=Storages.getFullPath(chapter),placed=Storages.getPlacedPath(chapter),local=Storages.getLocalName(full);
var route=Scripts.evalStorage(chapter),opening=Scripts.evalStorage(storyDrive+":/routes/開幕.tjs");
Storages.addAutoPath(storyDrive+":/Routes/");
var fromSearch=Scripts.evalStorage("Moon Finale.tjs");
Storages.removeAutoPath(storyDrive+":/Routes/");
var content=[full,placed,local,route,opening,fromSearch,int(Storages.isExistentStorage(storyDrive+":/Empty.dat"))].join("|");
'@, [Text.Encoding]::Unicode)
  [IO.File]::WriteAllText((Join-Path $game 'startup.tjs'), @'
System.exitOnNoWindowStartup=false;
var rows=["start"];rows.save("native-events.txt");
try {
 Scripts.execStorage("lookup.tjs");rows.add("source|"+driveResult);
 rows.add("contract|"+contract);rows.add("content|"+content);rows.add("done");
} catch(e) { rows.add("error|"+e.message); }
rows.save("native-events.txt");System.exit();
'@, [Text.Encoding]::Unicode)
  & "$PSScriptRoot/original-eri.ps1" -Project disc-volume
  $rows = @(Get-Content -LiteralPath (Join-Path $game 'native-events.txt'))
  $report.rows = $rows
  $drives = "$($volumes[0].drive)|$($volumes[1].drive)|"
  $letter = $volumes[2].drive.ToLowerInvariant()
  $file = "file://./$letter/routes/moon finale.tjs"
  $wanted = @('start',"source|$drives",'contract|2|1|2',"content|$file|$file|${letter}:\routes\moon finale.tjs|Moon disc scene|42|Moon disc scene|1",'done')
  if (($rows -join "`n") -cne ($wanted -join "`n")) { throw 'Stock drive lookup differs from the mounted volumes' }
  $report.matched = $true
} catch { $report.error = $_.Exception.ToString(); throw }
finally {
  foreach ($image in $mounted) {
    try { Dismount-DiskImage -ImagePath $image -ErrorAction Stop }
    catch { $cleanup += $_.Exception.ToString() }
  }
  $report.volumes = $volumes
  $report.cleanupErrors = $cleanup
  $report | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $output 'comparison.json') -Encoding utf8
  if ($cleanup.Count -and !$report.error) { throw 'Could not dismount a fixture image' }
}
