# BeakSight 本番用ソースアーカイブスクリプト。
# 依存関係、生成物、テスト、フィクスチャ、ドキュメント、リポジトリのメタデータ、
# エージェント作業ファイルを除外し、ソースのみを含むZIPを作成する。
# 使い方: powershell -ExecutionPolicy Bypass -File tools/archive_beaksight.ps1
#        [-OutputDirectory path]
#
# -OutputDirectory の既定値は、$env:BEAKSIGHT_ARCHIVE_OUTPUT_DIR が設定されて
# いればその値、未設定ならリポジトリと同じ階層の "BeakSight-archive" フォルダ
# となる。このスクリプトを編集せずに端末固有の出力先を使いたい場合は、各自の
# ローカルシェルプロファイルで環境変数を設定すること。

param(
    [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
if (-not ("BeakSightArchivePath" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class BeakSightArchivePath
{
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileShareDelete = 0x00000004;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        SafeFileHandle fileHandle,
        StringBuilder path,
        uint pathLength,
        uint flags);

    public static string GetFinalPath(string path)
    {
        using (SafeFileHandle handle = CreateFile(
            path,
            0,
            FileShareRead | FileShareWrite | FileShareDelete,
            IntPtr.Zero,
            OpenExisting,
            FileFlagBackupSemantics,
            IntPtr.Zero))
        {
            if (handle.IsInvalid)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            StringBuilder result = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(handle, result, (uint)result.Capacity, 0);
            if (length == 0 || length >= result.Capacity)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            return result.ToString();
        }
    }
}
"@
}

function Get-CanonicalPath {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $existingPath = $fullPath
    $missingSegments = [Collections.Generic.Stack[string]]::new()
    while (-not (Test-Path -LiteralPath $existingPath)) {
        $parentPath = Split-Path -Parent $existingPath
        if (-not $parentPath -or $parentPath -eq $existingPath) {
            throw "Cannot resolve an existing ancestor for path: $fullPath"
        }

        $missingSegments.Push((Split-Path -Leaf $existingPath))
        $existingPath = $parentPath
    }

    $canonicalPath = [BeakSightArchivePath]::GetFinalPath($existingPath)
    if ($canonicalPath.StartsWith("\\?\UNC\", [StringComparison]::OrdinalIgnoreCase)) {
        $canonicalPath = "\\" + $canonicalPath.Substring(8)
    } elseif ($canonicalPath.StartsWith("\\?\", [StringComparison]::OrdinalIgnoreCase)) {
        $canonicalPath = $canonicalPath.Substring(4)
    }

    while ($missingSegments.Count -gt 0) {
        $canonicalPath = Join-Path $canonicalPath $missingSegments.Pop()
    }

    return [IO.Path]::GetFullPath($canonicalPath).TrimEnd('\', '/')
}

$repoRoot = Get-CanonicalPath (Split-Path -Parent $PSScriptRoot)
$repoRootWithSeparator = $repoRoot + [IO.Path]::DirectorySeparatorChar

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    if (-not [string]::IsNullOrWhiteSpace($env:BEAKSIGHT_ARCHIVE_OUTPUT_DIR)) {
        $OutputDirectory = $env:BEAKSIGHT_ARCHIVE_OUTPUT_DIR
    } else {
        $OutputDirectory = Join-Path (Split-Path -Parent $repoRoot) "BeakSight-archive"
    }
}

$requestedOutputDirectoryPath = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\', '/')
$pathToInspect = $requestedOutputDirectoryPath
while ($pathToInspect) {
    if (Test-Path -LiteralPath $pathToInspect) {
        $pathItem = Get-Item -LiteralPath $pathToInspect -Force
        if (($pathItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Output directory paths must not contain reparse points: $pathToInspect"
        }
    }

    $parentPath = Split-Path -Parent $pathToInspect
    if (-not $parentPath -or $parentPath -eq $pathToInspect) {
        break
    }

    $pathToInspect = $parentPath
}

$outputDirectoryPath = Get-CanonicalPath $requestedOutputDirectoryPath
$outputDirectoryWithSeparator = $outputDirectoryPath + [IO.Path]::DirectorySeparatorChar
$fileSystemRoot = [IO.Path]::GetPathRoot($outputDirectoryPath).TrimEnd('\', '/')

if ($outputDirectoryPath -eq $fileSystemRoot -or
    $outputDirectoryPath.Equals($repoRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $repoRoot.StartsWith($outputDirectoryWithSeparator, [StringComparison]::OrdinalIgnoreCase) -or
    $outputDirectoryPath.StartsWith($repoRootWithSeparator, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe output directory: $outputDirectoryPath"
}

$includeDirectories = @(
    "src",
    "config",
    "schemas"
)
$includeFiles = @(
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.build.json"
)

$items = @()
foreach ($directoryName in $includeDirectories) {
    $directoryPath = Join-Path $repoRoot $directoryName
    if (-not (Test-Path -LiteralPath $directoryPath -PathType Container)) {
        throw "Required production directory is missing: $directoryPath"
    }

    $directoryRootItem = Get-Item -LiteralPath $directoryPath -Force
    if (($directoryRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Production inputs must not contain reparse points: $($directoryRootItem.FullName)"
    }

    $directoryItems = @(Get-ChildItem -LiteralPath $directoryPath -Recurse -Force)
    $reparseItem = $directoryItems | Where-Object {
        ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    } | Select-Object -First 1
    if ($null -ne $reparseItem) {
        throw "Production inputs must not contain reparse points: $($reparseItem.FullName)"
    }

    $items += $directoryItems | Where-Object { -not $_.PSIsContainer }
}

foreach ($fileName in $includeFiles) {
    $filePath = Join-Path $repoRoot $fileName
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
        throw "Required production file is missing: $filePath"
    }

    $fileItem = Get-Item -LiteralPath $filePath -Force
    if (($fileItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Production inputs must not contain reparse points: $($fileItem.FullName)"
    }

    $items += $fileItem
}

if ($items.Count -eq 0) {
    throw "No production files found to archive."
}

if (Test-Path -LiteralPath $outputDirectoryPath) {
    foreach ($child in Get-ChildItem -LiteralPath $outputDirectoryPath -Force) {
        $childPath = [IO.Path]::GetFullPath($child.FullName)
        if (-not $childPath.StartsWith($outputDirectoryWithSeparator, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove an item outside the output directory: $childPath"
        }

        Remove-Item -LiteralPath $childPath -Recurse -Force
    }
} else {
    New-Item -ItemType Directory -Path $outputDirectoryPath -Force | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$archivePath = Join-Path $outputDirectoryPath "BeakSight-$timestamp.zip"

Write-Host "Creating archive: $archivePath"
Write-Host "Included directories: $($includeDirectories -join ', ')"
Write-Host "Included root files: $($includeFiles -join ', ')"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = $null
try {
    $archive = [System.IO.Compression.ZipFile]::Open(
        $archivePath,
        [System.IO.Compression.ZipArchiveMode]::Create
    )
    foreach ($item in $items) {
        $relativePath = $item.FullName.Substring($repoRootWithSeparator.Length)
        $entryName = $relativePath -replace '\\', '/'
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive,
            $item.FullName,
            $entryName,
            [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
} catch {
    $archiveFailure = $_
    if ($null -ne $archive) {
        $archive.Dispose()
        $archive = $null
    }
    if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
        Remove-Item -LiteralPath $archivePath -Force
    }
    throw $archiveFailure
} finally {
    if ($null -ne $archive) {
        $archive.Dispose()
    }
}

Write-Host "Done. Archived $($items.Count) files to: $archivePath"
