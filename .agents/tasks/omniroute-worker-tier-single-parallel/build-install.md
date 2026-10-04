# Build & install: zoo-code 3.84.4 (omniroute worker tier + single parallel task)

- Branch: feat/omniroute-tier-dropdown-feat005 @ bb49024cb (includes a24a57c7e tier-header fix and bb49024cb parallel_tasks 1–4 fix)
- Build command: `pnpm vsix` (root; runs `turbo vsix` → `src`: `vsce package --no-dependencies --out ../bin`)
- Built vsix: /Users/celes/sources/celesrenata/menagerie/bin/zoo-code-3.84.4.vsix (34,603,197 bytes, built 2026-10-03 01:05; `unzip -t` clean; bundle contains `X-OmniRoute-Tier`)
- Install: `code --install-extension /Users/celes/sources/celesrenata/menagerie/bin/zoo-code-3.84.4.vsix --force` → "Extension 'zoo-code-3.84.4.vsix' was successfully installed."
- Flake copy: `cp -f` to /Users/celes/sources/m5max-darwin-flake/packages/vscode-extensions/zoo-code-3.84.4-omniroute.vsix; sha256 matches (4e9725bf…ff986). Flake repo not committed (left dirty).
- Action needed: reload VS Code (Developer: Reload Window) to load the new extension.
