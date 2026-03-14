# Post-commit hook to update version with the actual commit hash
# This runs after commit and amends it with the correct version

$indexFile = Join-Path $PSScriptRoot "index.html"

# Get the short git commit hash of the just-created commit
try {
    $gitHash = git rev-parse --short HEAD 2>$null
    if (-not $gitHash) {
        exit 0
    }
}
catch {
    exit 0
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

# Check current version in file
if ($content -match 'id="version">([^<]*)</div>') {
    $currentVersion = $matches[1]
    
    # Only update if version doesn't match the current commit
    if ($currentVersion -ne $version) {
        # Replace the version
        $newContent = $content -replace 'id="version">[^<]*</div>', "id=`"version`">$version</div>"
        
        # Write the updated file
        $newContent | Set-Content $indexFile -NoNewline
        
        # Stage the updated file
        git add $indexFile 2>$null
        
        # Amend the commit with the updated version
        git commit --amend --no-edit --no-verify 2>$null
        
        Write-Host "Version updated to: $version (commit amended)" -ForegroundColor Green
    }
}
