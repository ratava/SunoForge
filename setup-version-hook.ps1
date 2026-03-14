# Setup post-commit hook for automatic version updates
# Run this script once to enable automatic version numbering

$hookPath = Join-Path $PSScriptRoot ".git\hooks\post-commit"
$hookDir = Split-Path $hookPath -Parent

# Create hooks directory if it doesn't exist
if (-not (Test-Path $hookDir)) {
    New-Item -ItemType Directory -Path $hookDir -Force | Out-Null
}

# Create the post-commit hook
$hookContent = @'
#!/bin/sh
# Auto-generated post-commit hook for version updates
powershell.exe -ExecutionPolicy Bypass -File "./post-commit-version.ps1"
'@

$hookContent | Out-File -FilePath $hookPath -Encoding ASCII -NoNewline

Write-Host "Post-commit hook installed successfully!" -ForegroundColor Green
Write-Host "The version will now update automatically after each commit." -ForegroundColor Cyan
Write-Host ""
Write-Host "The version in index.html will match the commit hash it's contained in." -ForegroundColor Yellow
