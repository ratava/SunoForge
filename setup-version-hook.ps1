# Setup pre-commit hook for automatic version updates
# Run this script once to enable automatic version numbering

$hookPath = Join-Path $PSScriptRoot ".git\hooks\pre-commit"
$hookDir = Split-Path $hookPath -Parent

# Create hooks directory if it doesn't exist
if (-not (Test-Path $hookDir)) {
    New-Item -ItemType Directory -Path $hookDir -Force | Out-Null
}

# Create the pre-commit hook
$hookContent = @'
#!/bin/sh
# Auto-generated pre-commit hook for version updates
powershell.exe -ExecutionPolicy Bypass -File "./update-version.ps1"
'@

$hookContent | Out-File -FilePath $hookPath -Encoding ASCII -NoNewline

Write-Host "Pre-commit hook installed successfully!" -ForegroundColor Green
Write-Host "The version will now update automatically before each commit." -ForegroundColor Cyan
Write-Host ""
Write-Host "Note: The version shows the parent commit hash (the base you're building on)." -ForegroundColor Yellow
Write-Host "This is normal - a commit's hash can't be known before the commit is created." -ForegroundColor Yellow
