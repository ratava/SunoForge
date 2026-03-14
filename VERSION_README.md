# SunoForge Version System

The version number in the top right corner of the application uses a date-based rolling version format.

## Version Format

**Format:** `yyyymmdd-nnn`

Examples:
- `20260315-001` - First commit on March 15, 2026
- `20260315-002` - Second commit on March 15, 2026
- `20260315-003` - Third commit on March 15, 2026
- `20260316-001` - First commit on March 16, 2026 (counter resets)

## How It Works

- The version automatically increments with each commit
- The date portion (`yyyymmdd`) updates to the current date
- The counter (`nnn`) increments for each commit on the same day
- The counter resets to `001` on a new day
- The script reads the current version from `index.html` and calculates the next number

## Automatic Updates

A pre-commit hook automatically updates the version before each commit:

1. You make changes to the code
2. You run `git commit`
3. The pre-commit hook runs `update-version.ps1`
4. The script reads the current version from `index.html`
5. If it's the same day, it increments the counter (e.g., `001` → `002`)
6. If it's a new day, it resets to `001` with the new date
7. The updated file is added to your commit
8. The commit completes

## Setup Pre-Commit Hook

To enable automatic version updates:

**Quick Setup:**
```powershell
.\setup-version-hook.ps1
```

**Manual Setup (PowerShell):**
```powershell
# Create the pre-commit hook
@'
#!/bin/sh
powershell.exe -ExecutionPolicy Bypass -File "./update-version.ps1"
'@ | Out-File -FilePath .git/hooks/pre-commit -Encoding ASCII
```

**Git Bash (Windows/Mac/Linux):**
```bash
# Create the pre-commit hook
cat > .git/hooks/pre-commit << 'EOF'
#!/bin/sh
powershell.exe -ExecutionPolicy Bypass -File "./update-version.ps1"
EOF

# Make it executable
chmod +x .git/hooks/pre-commit
```

## Manual Updates

If you need to manually update the version:

```powershell
.\update-version.ps1
```

This will generate the next version number based on the current date and existing version.

## How It's Implemented

- **CSS**: `.version` class in the header styles the version display
- **HTML**: Version in the header: `<div class="version" id="version">dev</div>`
- **Script**: `update-version.ps1` calculates and updates the date-based rolling version
- **Hook**: `.git/hooks/pre-commit` runs the script automatically before each commit

The version is user-selectable (can be copied) and appears in a monospace font in the top right corner.
