# History AI Grader

History AI Grader is a React + Express application for middle school history homework grading, answer sheet recognition, and learning feedback analysis.

## Current Scope

- Choice question grading
- Subjective question grading
- Answer sheet upload and recognition
- Export of grading results and explanation documents
- Local-first runtime storage for evaluation and experimentation

## Open-Source Safety Notes

- This repository intentionally excludes all real student data, uploaded materials, logs, caches, and local debugging artifacts.
- Do not commit `data/app-state.json`, `data/uploads/`, `data/generated/`, `logs/`, `.env`, or any exported documents.
- API keys should be configured locally after launch and must never be committed.

## Development

### Requirements

- Node.js 24.x on Windows x64 is the currently verified environment.

### Install

```bash
npm install
npm --prefix frontend install
npm --prefix server install
npm run prepare:native
```

### Run in development

```bash
npm run dev:server
npm run dev:frontend
```

Frontend dev server: `http://127.0.0.1:5173`

Backend API: `http://127.0.0.1:3857`

## Production-style local run

Build the frontend and start the backend:

```bash
npm run build
npm start
```

After the frontend is built, the backend will serve the static app on the same port.

## Portable ZIP Release

This repository includes a Windows x64 portable packaging flow.

### Build locally

```bash
npm run release:zip:win-x64
```

The ZIP file is created at `release/history-ai-grader-win-x64.zip`.

### Release contents

- prebuilt frontend assets
- backend source
- server runtime dependencies
- empty `data/` and `logs/` directories
- `start.bat` and `start.ps1` launchers

### GitHub Release automation

Publishing a GitHub Release or manually triggering the `Release Portable ZIP` workflow will build the Windows x64 ZIP and attach it to the release.

## Repository Checklist Before Publishing

- add your own copyright name to `LICENSE`
- review screenshots and sample assets before committing them
- replace placeholder release notes with your project introduction
- add your sample questions, reference answers, and answer sheet templates later in a separate, sanitized sample-data folder

## Known Limitations

- The current app is still local-first and not yet multi-user.
- API settings are stored in local runtime state, so do not share a runtime data folder between users.
- Public server deployment should be protected with authentication before exposure to the internet.
