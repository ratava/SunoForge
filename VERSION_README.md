# SunoForge Version System

The version number in the top right corner of the application is automatically based on the git commit hash.

## How It Works

- The version is displayed in the header as a short git commit hash (e.g., `v86694d2`)
- If you're on a branch other than `main` or `master`, it shows as `hash@branchname`
- **The version shows the parent commit hash** - the base commit your changes are built on
- This is normal: a new commit's hash cannot be known before the commit is created

## Why Version is One Commit Behind

When you make a commit:
1. Pre-commit hook runs and sees current HEAD is `abc1234`
2. Updates `index.html` to show version `abc1234`
3. Commit is created with your changes + the version update
4. New commit gets hash `def5678`

So commit `def5678` contains version `abc1234`. This tells you what base version the code was built from.

## Automatic Updates

A pre-commit hook automatically updates the version before each commit:

1. You make changes to the code
2. You run `git commit`
3. The pre-commit hook runs `update-version.ps1`
4. The version in `index.html` is updated with current HEAD hash
5. The updated file is added to your commit
6. The commit completes with the new hash

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

## How It's Implemented

- **CSS**: `.version` class in the header styles the version display
- **HTML**: Version in the header: `<div class="version" id="version">dev</div>`
- **Script**: `update-version.ps1` updates the version with the git commit hash
- **Hook**: `.git/hooks/pre-commit` runs the script automatically before each commit

The version is user-selectable (can be copied) and appears in a monospace font in the top right corner.
