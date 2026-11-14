# Drift

Drift is a standalone macOS motion-wallpaper app. It runs independently, lives in the menu bar, and can restore a saved video wallpaper when you sign in.

## Download

Download the latest universal macOS `.dmg` from [GitHub Releases](../../releases/latest). It supports both Apple Silicon and Intel Macs running macOS 12 or newer.

Because this first public build is ad-hoc signed rather than Apple-notarized, macOS may ask you to confirm that you want to open it.

## Development

```bash
npm install
npm run tauri:dev
```

## Build

```bash
npm run tauri:build
```

Official releases are built in GitHub Actions from version tags, keeping local Rust build caches off the development Mac.
