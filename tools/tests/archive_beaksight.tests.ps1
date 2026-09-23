$ErrorActionPreference = "Stop"

function Assert-True {
    param(
        [Parameter(Mandatory)]
        [bool]$Condition,

        [Parameter(Mandatory)]
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scriptPath = Join-Path $repoRoot "tools\archive_beaksight.ps1"
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $tempRoot ("beaksight-archive-test-" + [guid]::NewGuid().ToString("N"))
$testOutputDirectory = Join-Path $testRoot "output"

try {
    New-Item -ItemType Directory -Path $testOutputDirectory -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $testOutputDirectory "stale.txt") -Value "remove me"
    $staleDirectory = Join-Path $testOutputDirectory "stale-directory\nested"
    New-Item -ItemType Directory -Path $staleDirectory -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $staleDirectory "stale.txt") -Value "remove me too"

    Assert-True -Condition (Test-Path -LiteralPath $scriptPath -PathType Leaf) `
        -Message "Archive script is missing: $scriptPath"

    & $scriptPath -OutputDirectory $testOutputDirectory

    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $testOutputDirectory "stale.txt"))) `
        -Message "The output directory was not cleared before archive creation."
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $testOutputDirectory "stale-directory"))) `
        -Message "A stale directory was not removed before archive creation."

    $archives = @(Get-ChildItem -LiteralPath $testOutputDirectory -File -Filter "*.zip")
    Assert-True -Condition ($archives.Count -eq 1) `
        -Message "Expected exactly one ZIP archive, found $($archives.Count)."
    Assert-True -Condition ($archives[0].Name -match '^BeakSight-\d{8}_\d{6}\.zip$') `
        -Message "Archive name does not use the expected timestamp format: $($archives[0].Name)"

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($archives[0].FullName)
    try {
        $entryNames = @($archive.Entries | ForEach-Object { $_.FullName })
    } finally {
        $archive.Dispose()
    }

    $requiredEntries = @(
        "src/core/status.ts",
        "config/targets/example.json",
        "schemas/run.schema.json",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "tsconfig.build.json"
    )
    foreach ($requiredEntry in $requiredEntries) {
        Assert-True -Condition ($entryNames -contains $requiredEntry) `
            -Message "Required production entry is missing: $requiredEntry"
    }

    $excludedPrefixes = @(
        ".git/",
        ".git-sandbox-backup/",
        ".superpowers/",
        "dist/",
        "doc/",
        "fixtures/",
        "node_modules/",
        "tests/",
        "tools/"
    )
    foreach ($excludedPrefix in $excludedPrefixes) {
        Assert-True -Condition (-not ($entryNames | Where-Object { $_.StartsWith($excludedPrefix, [StringComparison]::OrdinalIgnoreCase) })) `
            -Message "Excluded path was archived: $excludedPrefix"
    }

    $excludedRootFiles = @(".editorconfig", ".gitattributes", "vitest.config.ts")
    foreach ($excludedRootFile in $excludedRootFiles) {
        Assert-True -Condition ($entryNames -notcontains $excludedRootFile) `
            -Message "Excluded root file was archived: $excludedRootFile"
    }

    $expectedEntryNames = @(
        foreach ($directoryName in @("src", "config", "schemas")) {
            Get-ChildItem -LiteralPath (Join-Path $repoRoot $directoryName) -Recurse -File |
                ForEach-Object {
                    $_.FullName.Substring($repoRoot.Length + 1) -replace '\\', '/'
                }
        }
        "package.json"
        "package-lock.json"
        "tsconfig.json"
        "tsconfig.build.json"
    ) | Sort-Object
    $sortedEntryNames = @($entryNames | Sort-Object)
    $entryDifferences = @(Compare-Object -ReferenceObject $expectedEntryNames -DifferenceObject $sortedEntryNames)
    Assert-True -Condition ($entryDifferences.Count -eq 0) `
        -Message "Archive entries did not exactly match the approved production files: $($entryDifferences | Out-String)"

    $sandboxRepo = Join-Path $testRoot "sandbox-repo"
    New-Item -ItemType Directory -Path (Join-Path $sandboxRepo "tools") -Force | Out-Null
    Copy-Item -LiteralPath $scriptPath -Destination (Join-Path $sandboxRepo "tools\archive_beaksight.ps1")
    foreach ($directoryName in @("src", "config", "schemas")) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $directoryName) -Destination $sandboxRepo -Recurse
    }
    foreach ($fileName in @("package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json")) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $fileName) -Destination $sandboxRepo
    }

    $sourceSentinel = Join-Path $sandboxRepo "src\preserve-me.txt"
    Set-Content -LiteralPath $sourceSentinel -Value "must survive"
    $unsafePathRejected = $false
    try {
        & (Join-Path $sandboxRepo "tools\archive_beaksight.ps1") `
            -OutputDirectory (Join-Path $sandboxRepo "src")
    } catch {
        $unsafePathRejected = $true
    }

    Assert-True -Condition $unsafePathRejected `
        -Message "A repository descendant was accepted as the output directory."
    Assert-True -Condition (Test-Path -LiteralPath $sourceSentinel -PathType Leaf) `
        -Message "A repository descendant was modified before being rejected."

    $extendedOutputPath = "\\?\$($sandboxRepo)\src"
    $extendedPathRejected = $false
    try {
        & (Join-Path $sandboxRepo "tools\archive_beaksight.ps1") `
            -OutputDirectory $extendedOutputPath
    } catch {
        $extendedPathRejected = $true
    }

    Assert-True -Condition $extendedPathRejected `
        -Message "An extended-path repository descendant was accepted as the output directory."
    Assert-True -Condition (Test-Path -LiteralPath $sourceSentinel -PathType Leaf) `
        -Message "An extended-path repository descendant was modified before being rejected."

    $junctionOutput = Join-Path $testRoot "output-junction"
    New-Item -ItemType Junction -Path $junctionOutput -Target (Join-Path $sandboxRepo "src") | Out-Null
    $junctionRejected = $false
    try {
        & (Join-Path $sandboxRepo "tools\archive_beaksight.ps1") -OutputDirectory $junctionOutput
    } catch {
        $junctionRejected = $true
    }

    Assert-True -Condition $junctionRejected `
        -Message "A reparse-point output directory was accepted."
    Assert-True -Condition (Test-Path -LiteralPath $sourceSentinel -PathType Leaf) `
        -Message "A reparse-point output directory modified its target before being rejected."

    $reparseInputRepo = Join-Path $testRoot "reparse-input-repo"
    Copy-Item -LiteralPath $sandboxRepo -Destination $reparseInputRepo -Recurse
    $externalSourceDirectory = Join-Path $testRoot "external-source"
    New-Item -ItemType Directory -Path $externalSourceDirectory | Out-Null
    Set-Content -LiteralPath (Join-Path $externalSourceDirectory "outside.ts") -Value "outside content"
    New-Item -ItemType Junction `
        -Path (Join-Path $reparseInputRepo "src\external-source") `
        -Target $externalSourceDirectory | Out-Null

    $reparseInputRejected = $false
    try {
        & (Join-Path $reparseInputRepo "tools\archive_beaksight.ps1") `
            -OutputDirectory (Join-Path $testRoot "reparse-input-output")
    } catch {
        $reparseInputRejected = $true
    }

    Assert-True -Condition $reparseInputRejected `
        -Message "A reparse point inside an approved production directory was accepted."

    $reparseRootRepo = Join-Path $testRoot "reparse-root-repo"
    Copy-Item -LiteralPath $sandboxRepo -Destination $reparseRootRepo -Recurse
    $reparseRootConfig = Join-Path $reparseRootRepo "config"
    Remove-Item -LiteralPath $reparseRootConfig -Recurse -Force
    $externalConfigDirectory = Join-Path $testRoot "external-config"
    New-Item -ItemType Directory -Path $externalConfigDirectory | Out-Null
    Set-Content -LiteralPath (Join-Path $externalConfigDirectory "outside.json") -Value '{}'
    New-Item -ItemType Junction -Path $reparseRootConfig -Target $externalConfigDirectory | Out-Null

    $reparseRootRejected = $false
    try {
        & (Join-Path $reparseRootRepo "tools\archive_beaksight.ps1") `
            -OutputDirectory (Join-Path $testRoot "reparse-root-output")
    } catch {
        $reparseRootRejected = $true
    }

    Assert-True -Condition $reparseRootRejected `
        -Message "An approved production directory that is itself a reparse point was accepted."

    $missingInputRepo = Join-Path $testRoot "missing-input-repo"
    Copy-Item -LiteralPath $sandboxRepo -Destination $missingInputRepo -Recurse
    Remove-Item -LiteralPath (Join-Path $missingInputRepo "package.json") -Force
    $preservedOutput = Join-Path $testRoot "preserved-output"
    New-Item -ItemType Directory -Path $preservedOutput | Out-Null
    $outputSentinel = Join-Path $preservedOutput "existing-archive.zip"
    Set-Content -LiteralPath $outputSentinel -Value "must survive validation failure"

    $missingInputRejected = $false
    try {
        & (Join-Path $missingInputRepo "tools\archive_beaksight.ps1") `
            -OutputDirectory $preservedOutput
    } catch {
        $missingInputRejected = $true
    }

    Assert-True -Condition $missingInputRejected `
        -Message "A repository with a missing required input was accepted."
    Assert-True -Condition (Test-Path -LiteralPath $outputSentinel -PathType Leaf) `
        -Message "The output directory was cleared before source validation completed."

    $lockedInputRepo = Join-Path $testRoot "locked-input-repo"
    Copy-Item -LiteralPath $sandboxRepo -Destination $lockedInputRepo -Recurse
    $failedArchiveOutput = Join-Path $testRoot "failed-archive-output"
    $lockedFilePath = Join-Path $lockedInputRepo "src\core\status.ts"
    $lockedFile = [IO.File]::Open(
        $lockedFilePath,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::None
    )
    try {
        $archiveFailureObserved = $false
        try {
            & (Join-Path $lockedInputRepo "tools\archive_beaksight.ps1") `
                -OutputDirectory $failedArchiveOutput
        } catch {
            $archiveFailureObserved = $true
        }
    } finally {
        $lockedFile.Dispose()
    }

    Assert-True -Condition $archiveFailureObserved `
        -Message "The locked source file did not cause archive creation to fail."
    $incompleteArchives = @(Get-ChildItem -LiteralPath $failedArchiveOutput -File -Filter "*.zip")
    Assert-True -Condition ($incompleteArchives.Count -eq 0) `
        -Message "An incomplete ZIP was left behind after archive creation failed."

    Write-Host "PASS: archive_beaksight.ps1 creates a production-only archive."
} finally {
    $resolvedTestOutput = [IO.Path]::GetFullPath($testRoot)
    $expectedPrefix = $tempRoot + [IO.Path]::DirectorySeparatorChar
    if ($resolvedTestOutput.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedTestOutput).StartsWith("beaksight-archive-test-", [StringComparison]::Ordinal)) {
        Remove-Item -LiteralPath $resolvedTestOutput -Recurse -Force -ErrorAction SilentlyContinue
    }
}
