$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
  throw 'Boot-disc comparison requires GitHub-hosted Windows.'
}
$fixtures = Join-Path $env:GITHUB_WORKSPACE 'out/verification/disc-volumes'
$output = Join-Path $env:GITHUB_WORKSPACE 'out/verification/native-eri/disc-boot'
$game = Join-Path $output 'game'
New-Item -ItemType Directory -Force $game | Out-Null
$report = [ordered]@{ commit = $env:GITHUB_SHA; run = $env:GITHUB_RUN_ID; complete = $false; error = $null; cleanupError = $null
  scope = 'Original SDK reads the same mounted disc, original KAG XP3 members, authored patch menu and bitmap. Full interactive boot and save restoration are exercised by the Web library tests.' }
$mounted = $false
try {
  $manifest = Get-Content (Join-Path $fixtures 'boot-manifest.json') -Raw | ConvertFrom-Json
  if (!$manifest.complete -or $manifest.schema -ne 1 -or $manifest.commit -cne $env:GITHUB_SHA) { throw 'Incomplete boot-disc input manifest.' }
  $entry = @($manifest.images | Where-Object { $_.mode -ceq 'source' })
  if ($entry.Count -ne 1) { throw 'Missing unique source disc input.' }
  $image = Join-Path $fixtures $entry[0].name
  if ((Get-Item $image).Length -ne $entry[0].bytes -or (Get-FileHash -Algorithm SHA256 $image).Hash.ToLowerInvariant() -cne $entry[0].sha256) {
    throw 'Boot disc identity differs.'
  }
  $disc = Mount-DiskImage -ImagePath $image -StorageType ISO -Access ReadOnly -PassThru
  $mounted = $true
  $volume = $disc | Get-Volume -ErrorAction SilentlyContinue
  for ($attempt = 0; $attempt -lt 20 -and !$volume.DriveLetter; $attempt++) {
    Start-Sleep -Milliseconds 250
    $volume = Get-DiskImage -ImagePath $image | Get-Volume -ErrorAction SilentlyContinue
  }
  if (!$volume.DriveLetter -or $volume.FileSystemLabel -cne 'KRKR_STORY') { throw 'The authored boot volume is unavailable.' }
  $root = "$($volume.DriveLetter):\"
  foreach ($file in $entry[0].files) {
    $path = Join-Path $root $file.name
    if ((Get-Item -LiteralPath $path).Length -ne $file.bytes -or (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -cne $file.sha256) {
      throw "Mounted project bytes differ: $($file.name)"
    }
  }
  $report.drive = [string]$volume.DriveLetter
  $report.imageSha256 = $entry[0].sha256
  [IO.File]::WriteAllText((Join-Path $game 'startup.tjs'), @'
System.exitOnNoWindowStartup=false;
var rows=["start"],parser=void,w=void,image=void,failed=false;
function record(value){global.rows.add(value);global.rows.save("native-events.txt");}
rows.save("native-events.txt");
try{
 var drive=Storages.searchCD("krkr_story"),root=drive+":/DiscGame/";
 var startup=[].load(root+"data.xp3>startup.tjs"),initialize=[].load(root+"data.xp3>system/Initialize.tjs");
 startup.save("disc-original-startup.txt");initialize.save("disc-original-initialize.txt");
 record("template|"+int(startup.join("\n").indexOf("Initialize.tjs")>=0)+"|"+int(initialize.join("\n").indexOf("AfterInit2.tjs")>=0));
 var menu=[].load(root+"patch.xp3>first.ks");menu.save("disc-authored-menu.txt");
 parser=new KAGParser();parser.loadScenario(root+"patch.xp3>first.ks");
 var text="",links=[],stop="";
 for(var i=0;i<512;i++){
  var tag=parser.getNextTag();if(tag===null)break;
  if(tag.tagname=="ch")text+=tag.text;
  if(tag.tagname=="link")links.add(tag.target);
  if(tag.tagname=="s"){stop="s";break;}
 }
 record("menu|"+text+"|"+links.join(",")+"|"+parser.curLabel+"|"+stop);
 record("scripts|"+Scripts.evalStorage(drive+":/Routes/Moon Finale.tjs")+"|"+Scripts.evalStorage(drive+":/Routes/開幕.tjs"));
 w=new Window();image=new Layer(w,null);image.loadImages(drive+":/Art/Title.bmp");
 record("image|"+image.imageWidth+"|"+image.imageHeight+"|"+image.getMainPixel(0,0));
}catch(e){failed=true;record("error|"+e.message);}
try{if(image!==void && isvalid image)invalidate image;}catch(e){failed=true;record("cleanup|"+e.message);}
try{if(w!==void && isvalid w)invalidate w;}catch(e){failed=true;record("cleanup|"+e.message);}
try{if(parser!==void && isvalid parser)invalidate parser;}catch(e){failed=true;record("cleanup|"+e.message);}
if(!failed)record("done");System.exit();
'@, [Text.Encoding]::Unicode)
  & "$PSScriptRoot/original-eri.ps1" -Project disc-boot
  $rows = @(Get-Content -LiteralPath (Join-Path $game 'native-events.txt'))
  $report.rows = $rows
  $expected = @('start','template|1|1','menu|Open the story discRead chapter / Load chapter|*enter,*load|*choice|s',
    'scripts|Moon disc scene|42','image|4|4|3368601','done')
  if (($rows -join "`n") -cne ($expected -join "`n")) { throw 'The original SDK did not read the complete disc inputs as authored.' }
  $report.complete = $true
} catch { $report.error = $_.Exception.ToString(); throw }
finally {
  try {
    if ($mounted) {
      try { Dismount-DiskImage -ImagePath $image -ErrorAction Stop }
      catch { $report.cleanupError = $_.Exception.ToString(); if (!$report.error) { throw } }
    }
  } finally { $report | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $output 'comparison.json') -Encoding utf8 }
}
