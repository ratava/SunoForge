# SunoForge Version System

The version number in the top right corner of the application is automatically based on the current git commit hash.

## How It Works

- The version is displayed in the header as a short git commit hash (e.g., `ve32dce1`)
- If you're on a branch other than `main` or `master`, it shows as `hash@branchname`
- The version in the file always matches the commit hash it's contained in

## Automatic Updates

A post-commit hook automatically updates the version after each commit:

1. You make changes to the code
2. You run `git commit`
3. The commit is created
4. The post-commit hook runs `post-commit-version.ps1`
5. The version in `index.html` is updated with the actual commit hash
6. The commit is automatically amended to include the correct version

This ensures the version displayed always matches the commit hash of the code.

## Setup Post-Commit Hook

To enable automatic version updates:

**PowerShell (Windows):**
```powershell
# Create the post-commit hook
@'
#!/bin/sh
powershell.exe -ExecutionPolicy Bypass -File "./post-commit-version.ps1"
'@ | Out-File -FilePath .git/hooks/post-commit -Encoding ASCII

# Make it executable (Git Bash)
git update-index --chmod=+x .git/hooks/post-commit
```

**Git Bash (Windows/Mac/Linux):**
```bash
# Create the post-commit hook
cat > .git/hooks/post-commit << 'EOF'
#!/bin/sh
powershell.exe -ExecutionPolicy Bypass -File "./post-commit-version.ps1"
EOF

# Make it executable
chmod +x .git/hooks/post-commit
```

## Manual Updates

If you need to manually update the version, run:

```powershell
.\post-commit-version.ps1
```

## How It's Implemented

- **CSS**: `.version` class in the header styles the version display
- **HTML**: Version in the header: `<div class="version" id="version">dev</div>`
- **Script**: `post-commit-version.ps1` updates the version with the git commit hash using `--amend`
- **Hook**: `.git/hooks/post-commit` runs the script automatically after each commit

The version is user-selectable (can be copied) and appears in a monospace font in the top right corner.
