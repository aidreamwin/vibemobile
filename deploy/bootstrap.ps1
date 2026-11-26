# Substituted by scripts/release.mjs when publishing a release.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$role = @ROLE@
$archiveUrl = @ARCHIVE_URL@
$archiveSha256 = @ARCHIVE_SHA256@
$nodeVersion = @NODE_VERSION@

function Receive-File($Url, $Destination) {
    & curl.exe -fLsS --retry 3 --connect-timeout 15 -o $Destination $Url
    if ($LASTEXITCODE -ne 0) { throw 'Download failed.' }
}

function Assert-Checksum($File, $Hash) {
    if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -ine $Hash) {
        throw "SHA-256 verification failed: $File"
    }
}

function Find-Node {
    $installed = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($installed -and (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        $version = & $installed.Source --version
        if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) {
            return $installed.Source
        }
    }

    $arch = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
        'X64' { 'x64' }
        'Arm64' { 'arm64' }
        default { throw 'Install Node.js 22 or newer with npm first on this architecture.' }
    }
    $dist = "node-$nodeVersion-win-$arch"
    $runtime = Join-Path $env:LOCALAPPDATA 'vibemobile\runtime'
    $nodeDir = Join-Path $runtime $dist
    $nodeExe = Join-Path $nodeDir 'node.exe'
    if (-not (Test-Path -LiteralPath $nodeExe)) {
        Write-Host "Installing Node.js $nodeVersion for the current user..."
        $nodeUrl = "https://nodejs.org/dist/$nodeVersion"
        $checksumFile = Join-Path $tempInstall 'node-checksums'
        $zip = Join-Path $tempInstall 'node.zip'
        Receive-File "$nodeUrl/SHASUMS256.txt" $checksumFile
        $entry = Get-Content -LiteralPath $checksumFile | Where-Object { $_ -match "\s+$([regex]::Escape($dist)).zip$" } | Select-Object -First 1
        if (-not $entry) { throw "Node.js distribution is unavailable: $dist" }
        Receive-File "$nodeUrl/$dist.zip" $zip
        Assert-Checksum $zip (($entry -split '\s+')[0])
        & tar.exe -xf $zip -C $tempInstall
        if ($LASTEXITCODE -ne 0) { throw 'Could not extract Node.js.' }
        New-Item -ItemType Directory -Force -Path $runtime | Out-Null
        if (-not (Test-Path -LiteralPath $nodeDir)) {
            Move-Item -LiteralPath (Join-Path $tempInstall $dist) -Destination $runtime
        }
    }
    $env:Path = "$nodeDir;$env:Path"
    return $nodeExe
}

$tempInstall = Join-Path ([System.IO.Path]::GetTempPath()) ("vibemobile-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempInstall | Out-Null
try {
    Write-Host "Downloading VibeMobile $role..."
    $archive = Join-Path $tempInstall 'release.tar.gz'
    $package = Join-Path $tempInstall 'package'
    Receive-File $archiveUrl $archive
    Assert-Checksum $archive $archiveSha256
    New-Item -ItemType Directory -Path $package | Out-Null
    & tar.exe -xzf $archive -C $package
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract the release package.' }

    $node = Find-Node
    & $node (Join-Path $package 'deploy\quick-install.mjs') @args
    if ($LASTEXITCODE -ne 0) { throw 'VibeMobile installation failed.' }
} finally {
    # This path was created above with an unpredictable name under the system temporary directory.
    Remove-Item -LiteralPath $tempInstall -Recurse -Force
}
