# Update version in index.html based on git commit
# Run this script before committing or set it as a pre-commit hook

$indexFile = Join-Path $PSScriptRoot "index.html"

# Get the short git commit hash
try {
    $gitHash = git rev-parse --short HEAD 2>$null
    if (-not $gitHash) {
        $gitHash = "dev"
    }
}
catch {
    $gitHash = "dev"
}

# Get the current branch
try {
    $gitBranch = git rev-parse --abbrev-ref HEAD 2>$null
    if (-not $gitBranch) {
        $gitBranch = ""
    }
}
catch {
    $gitBranch = ""
}

# Create version string: hash or hash@branch if not on main/master
if ($gitBranch -and $gitBranch -ne "main" -and $gitBranch -ne "master") {
    $version = "$gitHash@$gitBranch"
}
else {
    $version = $gitHash
}

# Read the file content
$content = Get-Content $indexFile -Raw

# Replace the version placeholder
$newContent = $content -replace '<!--VERSION_PLACEHOLDER-->', $version

# Write back only if changed
if ($content -ne $newContent) {
    $newContent | Set-Content $indexFile -NoNewline
    Write-Host "Version updated to: $version" -ForegroundColor Green
}
else {
    Write-Host "Version already up to date: $version" -ForegroundColor Yellow
}
