# SunoForge Version System

The version number in the top right corner of the application is automatically based on the current git commit hash.

## How It Works

- The version is displayed in the header as a short git commit hash (e.g., `ve32dce1`)
- If you're on a branch other than `main` or `master`, it shows as `hash@branchname`

## Automatic Updates

A pre-commit hook is installed that automatically updates the version whenever you commit:

1. You make changes to the code
2. You run `git commit`
3. The pre-commit hook runs `update-version.ps1`
4. The version in `index.html` is updated with the latest commit hash
5. The updated file is added to your commit

## Manual Updates

If you need to manually update the version, run:

```powershell
.\update-version.ps1
```

## How It's Implemented

- **CSS**: `.version` class in the header styles the version display
- **HTML**: Version placeholder in the header: `<div class="version">v<!--VERSION_PLACEHOLDER--></div>`
- **Script**: `update-version.ps1` replaces the placeholder with the git commit hash
- **Hook**: `.git/hooks/pre-commit` runs the script automatically on each commit

The version is user-selectable (can be copied) and appears in a monospace font in the top right corner.
