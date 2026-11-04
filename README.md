# NEXUS AI

NEXUS AI — a local-first macOS AI coding IDE for Codex CLI, Claude Code, Gemini CLI and GitHub Copilot CLI. NEXUS provides a native desktop shell, project explorer, Monaco editor, multi-agent chat, Git workflow and an interactive local terminal.

## Requirements

- macOS 13 or later
- Node.js 22.18 or later (Node 24 recommended)
- Xcode Command Line Tools (required if the native `node-pty` module must be rebuilt from source)
- Git
- One or more of the supported provider CLIs installed and authenticated

## Install and run in development

```bash
npm install
npm run dev
```

The install hook runs `electron-builder install-app-deps` to rebuild native dependencies for the Electron runtime, then restores executable permissions on any `node-pty` `spawn-helper` binaries. The package configuration unpacks the complete `node-pty` module from ASAR so its native addon and runtime helper can be loaded by the operating system. If you change the Electron major version manually, run:

```bash
npm run postinstall
```

## Build and package

```bash
npm run typecheck
npm run build
npm run package:mac
```

The macOS packager outputs a DMG and ZIP under `release/`. The package is not signed or notarized with an Apple Developer identity; for local testing macOS may require you to open the app from Finder using Control-click → Open. For public distribution, configure Developer ID signing and notarization.

## Included capabilities

### Workspace and editor
- Local project folder picker, recent-project switcher and project history
- Recursive file explorer with filtering, create file/folder, open, edit, save and delete
- Monaco editor with language detection, minimap, syntax highlighting and multiple tabs
- File size guard (2 MB) and binary-file detection
- Workspace path checks; file-browser operations reject paths that escape the selected project and reject symbolic links

### AI agents
- Codex CLI: `codex exec --json`
- Claude Code: `claude -p --output-format stream-json --verbose --include-partial-messages`
- Gemini CLI: `gemini -p --output-format stream-json`
- GitHub Copilot CLI: `copilot -p --output-format json --assisted-approval` (uses Copilot's safety-review permission flow for eligible tool requests in non-interactive mode)
- CLI discovery through the user's login zsh environment, including Homebrew paths
- One or multiple selected agents can receive the same task concurrently
- Streaming output, duplicate-summary suppression, per-run stop controls, run status recovery after restart and local conversation history
- NEXUS does not store provider API keys or change provider permission modes

**Multi-agent note:** selected agents currently operate in the same project folder. Do not give concurrent agents overlapping edit tasks unless you are comfortable resolving file conflicts. For parallel work, assign independent tasks or use Git branches/worktrees manually.

### Git
- Current branch, changed file list, staged/unstaged status and recent commits
- File diff preview
- Stage and unstage individual paths
- Commit staged changes
- Branch listing and branch switching

### Terminal and diagnostics
- Interactive zsh terminal powered by `node-pty` 1.2 beta and xterm.js 6
- Terminal and agent output dock
- Provider CLI availability diagnostics
- Local app data and permission information in Settings

## Persistence

Project list and conversation history are stored in Electron's local `userData` directory as `nexus-state.json`. Project source files are read from and written to the selected local folder. The app does not upload project files itself; each provider CLI may transmit prompt/context/code according to its own account, settings and privacy terms.

## Toolchain

The project uses Electron 45, electron-vite 6, Vite 8, React 19 and TypeScript 6. `node-pty` is pinned to `1.2.0-beta.18` to address a reported macOS `spawn-helper` executable-bit issue. NEXUS also applies a permissions repair during install and before packaging, and explicitly unpacks `node-pty` from ASAR because its runtime helper must be executable by macOS.

## Security model

- Electron renderer uses context isolation and sandboxing; Node integration is disabled.
- Renderer accesses a small allowlisted IPC API through preload.
- Agent and Git commands use argument arrays rather than shell interpolation.
- The native terminal is an intentional shell with the user's normal local account permissions.
- Provider tools can edit project files and execute commands according to the provider CLI's own permission system. Review their permission prompts and generated changes.

## Known limitations

- Conversations are persisted by NEXUS and recent messages are passed as prompt context; NEXUS does not yet reconnect to provider-native session IDs for true provider-side resume.
- Concurrent agents share the same working tree; assign independent tasks to avoid file collisions. Dedicated per-agent Git worktrees and safe merge/review flows are not yet built in.
- Git diff display uses Monaco side-by-side comparison; it does not yet provide a staging-hunk editor, merge-conflict UI or interactive rebase.
- File browser skips common generated/vendor directories and limits traversal depth to keep large repositories responsive.
- CLI output schemas and flags can change between provider releases; run Diagnostics and check each CLI's own help/docs after provider updates. The app reports CLI installation, not provider account authentication.

## Project structure

```text
nexus-ai/
├── src/
│   ├── main/          # Electron main process, filesystem, Git, CLI and PTY services
│   ├── preload/       # Typed, allowlisted renderer bridge
│   └── renderer/      # React UI, Monaco editor, xterm and styling
├── electron.vite.config.ts
├── package.json
└── README.md
```

## Fix Monaco workers (v0.3.1)

Monaco Editor 0.56+ changed its package export map. Worker imports must use the new public subpaths (without the `esm/vs/` prefix), for example `monaco-editor/editor/editor.worker.js?worker`. The renderer entry point in this version already uses the corrected paths.

If upgrading an existing checkout, replace `src/renderer/src/main.tsx` with the file from this release. No dependency reinstall is required for this source-only change.
