[CmdletBinding()]
param(
    [string]$ZipPath,
    [switch]$AllowDirty
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$gitSafety = "safe.directory=$($repoRoot.Replace('\', '/'))"
$temporaryRoot = $null

function Assert-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Child
    )
    $resolvedParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $resolvedChild = [System.IO.Path]::GetFullPath($Child)
    if (-not $resolvedChild.StartsWith($resolvedParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe path outside expected parent: $resolvedChild"
    }
    return $resolvedChild
}

try {
    if ((Test-Path -LiteralPath (Join-Path $repoRoot '.git')) -and -not $AllowDirty) {
        $dirty = (& git -c $gitSafety -C $repoRoot status --porcelain --untracked-files=normal) -join "`n"
        if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Git status.' }
        if ($dirty.Trim()) {
            throw 'Repository has uncommitted changes. Commit/stash them first, or rerun with -AllowDirty after reviewing the risk.'
        }
    }

    if (-not $ZipPath) {
        $zip = Get-ChildItem -LiteralPath $repoRoot -Recurse -File -Filter '*.zip' |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First 1
        if (-not $zip) { throw "No Unity WebGL ZIP was found under $repoRoot." }
        $ZipPath = $zip.FullName
    }

    $resolvedZip = [System.IO.Path]::GetFullPath($ZipPath)
    if (-not (Test-Path -LiteralPath $resolvedZip -PathType Leaf)) { throw "ZIP does not exist: $resolvedZip" }

    $temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("game3d-unity-update-" + [System.Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
    Expand-Archive -LiteralPath $resolvedZip -DestinationPath $temporaryRoot -Force

    $candidates = Get-ChildItem -LiteralPath $temporaryRoot -Recurse -File -Filter 'index.html' |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.Directory.FullName 'Build') -PathType Container } |
        Sort-Object { $_.FullName.Length }
    if (-not $candidates) { throw 'The ZIP does not contain a Unity WebGL index.html next to a Build directory.' }

    $unityIndex = $candidates[0]
    $unityRoot = $unityIndex.Directory.FullName
    foreach ($required in @('Build', 'TemplateData')) {
        if (-not (Test-Path -LiteralPath (Join-Path $unityRoot $required) -PathType Container)) {
            throw "Unity build is missing $required."
        }
    }

    foreach ($directoryName in @('Build', 'TemplateData', 'StreamingAssets')) {
        $source = Join-Path $unityRoot $directoryName
        $destination = Assert-ChildPath -Parent $repoRoot -Child (Join-Path $repoRoot $directoryName)
        if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force }
    }

    $projectVersion = Join-Path $unityRoot 'ProjectVersion.txt'
    if (Test-Path -LiteralPath $projectVersion -PathType Leaf) {
        Copy-Item -LiteralPath $projectVersion -Destination (Join-Path $repoRoot 'ProjectVersion.txt') -Force
    }

    $node = (Get-Command node -ErrorAction Stop).Source
    & $node (Join-Path $repoRoot 'scripts\normalize-unity-build.mjs') --repo $repoRoot --unity-index $unityIndex.FullName
    if ($LASTEXITCODE -ne 0) { throw 'Unity asset normalization failed.' }
    & $node (Join-Path $repoRoot 'scripts\prepare-pages.mjs') --source $repoRoot --output (Join-Path $repoRoot '_site')
    if ($LASTEXITCODE -ne 0) { throw 'Local Pages build validation failed.' }

    Write-Host "Imported Unity WebGL ZIP: $resolvedZip"
    Write-Host "Detected Unity root: $unityRoot"
    Write-Host 'Review git diff, then commit and push main.'
    & git -c $gitSafety -C $repoRoot status --short
}
finally {
    if ($temporaryRoot -and (Test-Path -LiteralPath $temporaryRoot)) {
        $safeTemporaryRoot = Assert-ChildPath -Parent ([System.IO.Path]::GetTempPath()) -Child $temporaryRoot
        Remove-Item -LiteralPath $safeTemporaryRoot -Recurse -Force
    }
}
