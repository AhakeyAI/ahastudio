# Third-Party Notices

This project (`ahastation-local-cli`) is licensed under the **Apache License, Version 2.0** (see [LICENSE](./LICENSE)).
Certain ported, adapted, or bundled components retain their original upstream copyright notices and permissive licenses as listed below.

---

## 1. Orca (`https://github.com/stablyai/orca`)

- **License:** MIT License
- **Copyright:** Copyright (c) 2026 Lovecast Inc.
- **Full license text:** See [src/assets/cli-icons/THIRD-PARTY-LICENSE.txt](./src/assets/cli-icons/THIRD-PARTY-LICENSE.txt) and the MIT License section below.
- **Ported / adapted files in this repository:**
  - `electron/shared/**` (terminal escape/protocol/replay/appearance/link helpers, `osc7-path-text.ts`, `powershell-command-encoding.ts`, `windows-retry-file-operations.ts`, `wsl-paths.ts`, `osc-title-extraction.ts`, `node-file-content-equality.ts`)
  - `src/lib/shared/**` (`cross-platform-path.ts`, `own-retained-string.ts`, `owned-utf16-suffix.ts`, `prose-url-boundary.ts`, `wsl-paths.ts`, `file-links/*`, `native-chat/*`, `terminal/links/*`, `terminal/output/*`)
  - `electron/persistence/atomic-file-publication.ts`, `atomic-snapshot-writer.ts`, `durable-file-write.ts`, `permission-errors.ts`
  - `electron/terminal-daemon/emulation/*`, `electron/terminal-daemon/protocol/terminal-modes.ts`, `electron/terminal-daemon/protocol/terminal-snapshot.ts`, `electron/terminal-daemon/windows-conpty-warmup.ts`
  - `electron/shell-integration/bash-prompt-command-composition.ts`, `electron/shell-integration/powershell-bootstrap.ts`
  - `electron/ipc/launchable-file-type.ts`, `electron/ipc/linked-file-inspection.ts`
  - `electron/agent/agent-prompt-delivery.ts`, `electron/agent/program-status-osc.ts` (adapted portions)
  - `electron/orchestration/orchestration-task-display.ts` (plus orchestration patterns adapted from Orca's orchestration subsystem)
  - `src/lib/terminal-appearance.ts` (Builtin Tango Light palette)
  - `src/components/TerminalBrandIcons.tsx` (adapted SVG brand icon components)
  - `src/assets/cli-icons/antigravity.png`, `src/assets/cli-icons/grok.png`, `src/assets/cli-icons/qoder.png`

## 2. Visual Studio Code (`https://github.com/microsoft/vscode`)

- **License:** MIT License
- **Copyright:** Copyright (c) Microsoft Corporation
- **Ported / adapted files:**
  - `src/lib/shared/terminal/links/terminal-links.ts` (local path and word link detection logic ported via Orca from `terminalLocalLinkDetector.ts` and `terminalWordLinkDetector.ts`)

## 3. Simple Icons (`https://simpleicons.org/`)

- **License:** CC0 1.0 Universal
- **Used in:**
  - `src/components/TerminalBrandIcons.tsx` (`OpenCodeIcon`, `QwenIcon`, `PiIcon`, `GeminiIcon` SVG paths)

## 4. Bundled Voice Activity Detection (VAD) Assets (`public/vad/`)

- **ONNX Runtime Web** (`public/vad/ort-wasm-simd-threaded*.mjs`, `*.wasm`): MIT License, Copyright (c) Microsoft Corporation (`https://github.com/microsoft/onnxruntime`)
- **@ricky0123/vad-web** (`public/vad/vad.worklet.bundle.min.js`): ISC License (`https://github.com/ricky0123/vad`)
- **Silero VAD** (`public/vad/silero_vad_v5.onnx`): MIT License (`https://github.com/snakers4/silero-vad`)

---

## License Texts

### MIT License (Orca / Microsoft)

Applies to the Orca, Visual Studio Code, ONNX Runtime Web, and Silero VAD components listed above (with the respective upstream Copyright notices).

```text
MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```