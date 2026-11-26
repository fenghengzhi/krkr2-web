param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Output, [switch]$Bridge)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Disc authoring requires a GitHub-hosted Windows runner'
}
# IMAPI returns the complete image as an IStream. Copy each block exactly
# once, including a final short read, without adding image padding.
if (-not ('MasteredDisc' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class MasteredDisc {
    public static void Write(object value, long length, string path) {
        IStream stream = (IStream)value;
        byte[] block = new byte[65536];
        IntPtr result = Marshal.AllocCoTaskMem(sizeof(int));
        try {
            using (FileStream output = new FileStream(path, FileMode.CreateNew, FileAccess.Write)) {
                while (length > 0) {
                    int wanted = (int)Math.Min(length, block.Length);
                    stream.Read(block, wanted, result);
                    int count = Marshal.ReadInt32(result);
                    if (count <= 0 || count > wanted) throw new EndOfStreamException();
                    output.Write(block, 0, count);
                    length -= count;
                }
            }
        } finally { Marshal.FreeCoTaskMem(result); }
    }
}
'@
}
$image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
$image.FileSystemsToCreate = if ($Bridge) { 5 } else { 4 } # UDF or UDF + ISO9660
if ($Bridge) { $image.ISO9660InterchangeLevel = 1 }
$image.FreeMediaBlocks = 32768
$image.UDFRevision = 0x250
$image.CreateRedundantUdfMetadataFiles = $true
$image.VolumeName = 'KRKR_STORY'
$image.Root.AddTree((Resolve-Path -LiteralPath $Source).Path, $false)
$result = $image.CreateResultImage()
if ($result.BlockSize -ne 2048 -or $result.TotalBlocks -le 256) { throw 'Unexpected IMAPI image geometry' }
[MasteredDisc]::Write($result.ImageStream, ([long]$result.TotalBlocks * $result.BlockSize),
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Output))
