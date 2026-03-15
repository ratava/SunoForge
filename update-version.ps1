# Update version in index.html with date-based rolling version
# Format: yyyymmdd-nnn (e.g., 20260315-001)

$indexFile = Join-Path $PSScriptRoot "index.html"

# Get today's date in yyyymmdd format
$dateString = Get-Date -Format "yyyyMMdd"

# Read the current version from the file
$content = Get-Content $indexFile -Raw

# Extract current version
$currentVersion = "dev"
if ($content -match 'id="version">([^<]*)</div>') {
    $currentVersion = $matches[1]
}

# Determine next version number
$versionNumber = 1
if ($currentVersion -match '^(\d{8})-(\d{3})$') {
    $versionDate = $matches[1]
    $versionNum = [int]$matches[2]
    
    if ($versionDate -eq $dateString) {
        # Same day - increment the number
        $versionNumber = $versionNum + 1
    }
    # else: New day - start at 1
}

# Format the new version
$version = "{0}-{1:D3}" -f $dateString, $versionNumber

# Replace the entire version div content
$newContent = $content -replace 'id="version">[^<]*</div>', "id=`"version`">Version: <br>$version</div>"

# Write back only if changed
if ($content -ne $newContent) {
    $newContent | Set-Content $indexFile -NoNewline
    
    # Stage the file for commit
    git add $indexFile 2>$null
    
    Write-Host "Version updated to: $version" -ForegroundColor Green
}
else {
    Write-Host "Version already up to date: $version" -ForegroundColor Yellow
}
