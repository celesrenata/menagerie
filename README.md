<p align="center">
  <a href="https://github.com/celesrenata/menagerie"><img src="https://img.shields.io/badge/GitHub-celesrenata%2Fmenagerie-181717?style=flat&logo=github&logoColor=white" alt="GitHub"></a>
  <a href="https://github.com/celesrenata/menagerie/releases"><img src="https://img.shields.io/badge/Release_notes-2EA44F?style=flat&logo=github&logoColor=white" alt="Release notes"></a>
  <a href="https://github.com/celesrenata/menagerie/issues"><img src="https://img.shields.io/badge/GitHub-Issues-181717?style=flat&logo=github&logoColor=white" alt="GitHub Issues"></a>
</p>

# Menagerie

> A VS Code coding agent built to keep a whole menagerie of local and routed models busy at once.

Menagerie is an AI coding agent for VS Code. It plans, reads, edits, runs commands
and verifies its own work, and it is designed around an OmniRoute inference fabric:
many local models working in parallel, with cloud models as a fallback rather than
the default.

Menagerie is a fork of [Zoo Code](https://github.com/Zoo-Code-Org/Zoo-Code), which
continued [Roo Code](https://github.com/RooCodeInc/Roo-Code). On first start it
imports your Zoo Code task history and settings.

## What Menagerie adds

- **Background subtasks.** `parallel_tasks` can run in the background, so the top-level
  model keeps working while workers run. Results arrive on its next turn, and the
  `background_tasks` tool checks status, sends steering to a running worker, cancels or
  waits. Fan-out goes up to 12 workers, with lane slots sized for local inference.
- **Audit and send back.** Workers that edit files are checked by a read-only reader.
  Rejected work goes back for up to two rework rounds, then escalates to a deeper lane.
  Work that never passes ends as failed, not completed.
- **Fewer interruptions.** Before asking you a question, Menagerie checks answers you
  gave before, your original request and the project docs. A fast reader then tries to
  answer from them with citations, and a deeper reader tries next. A repeated question
  always reaches you.
- **OmniRoute Skill Hub.** Turn each hub skill on, off or auto. Manual choices always
  win; auto fills the remaining slots with hub matches for the current task. The hub
  key is kept in VS Code secret storage.
- **Task Board.** Summaries, expandable details, pause, resume, restart and cancel, and
  tasks that recover after a reload.
- **Spec-driven workflows.** Import and approve spec revisions, run strict batches in a
  patch sandbox, and verify them with host-run checks.
- **OmniRoute routing.** Cost tiers route to `pool/tierN/<role>` models, condensing uses
  each route's real served context window, and capacity-aware scheduling spreads work
  across backends.
- **No analytics.** Menagerie sends no usage data and shows no telemetry prompt.

## Modes

Menagerie adapts to how you work:

- **Code mode:** everyday coding, edits and file operations
- **Architect mode:** plan systems, specs and migrations
- **Ask mode:** fast answers, explanations and docs
- **Debug mode:** trace issues, add logs and isolate root causes
- **Custom modes:** build specialized modes for your team or workflow

The Nix flake ships two custom mode packs (`aar` and `repo`). See
[`nix/README.md`](nix/README.md).

## Install

### Nix (home-manager)

The flake builds the extension from source and ships home-manager, NixOS and
nix-darwin modules. With home-manager:

```nix
{
  inputs.menagerie.url = "github:celesrenata/menagerie";
  # ...
  imports = [ inputs.menagerie.homeManagerModules.default ];
  programs.menagerie.enable = true;
}
```

On every switch the module copies the build into `~/.vscode/extensions`, recopying
whenever the build changes, and removes any old Zoo Code install. Reload VS Code
windows afterwards.

To build just the package:

```sh
nix build github:celesrenata/menagerie#menagerie-vsix
code --install-extension ./result/menagerie-*.vsix
```

See [`nix/README.md`](nix/README.md) for every output and module option.

### From source

```sh
git clone https://github.com/celesrenata/menagerie.git
cd menagerie
pnpm install
pnpm vsix
code --install-extension bin/menagerie-<version>.vsix
```

## Development

- **F5 (Run → Start Debugging)** opens a new VS Code window with Menagerie running.
  Webview and extension changes hot reload.
- **`pnpm install:vsix [-y] [--editor=<command>]`** builds the VSIX and installs it
  into `code`, `cursor` or `code-insiders`, replacing any existing copy.
- **Tests:** run Vitest from the package that declares it, for example
  `cd src && npx vitest run <path>` or `cd webview-ui && npx vitest run <path>`.
  Lifecycle changes also need `pnpm lifecycle:model-check`.

Read [`AGENTS.md`](AGENTS.md) before changing settings, task lifecycle or lint
suppressions.

## Resources

- **[Release notes](https://github.com/celesrenata/menagerie/releases)** and
  [`CHANGELOG.md`](CHANGELOG.md)
- **[GitHub Issues](https://github.com/celesrenata/menagerie/issues):** report bugs
  and request features
- **[Granite analysis ADR](docs/architecture/granite-analysis-adr.md)** and the
  [task lifecycle model](docs/architecture/task-lifecycle-model.md)

## Disclaimer

**Please note** that Menagerie does **not** make any representations or warranties
regarding any code, models, or other tools provided or made available in connection
with Menagerie, any associated third-party tools, or any resulting outputs. You
assume **all risks** associated with the use of any such tools or outputs; such tools
are provided on an **"AS IS"** and **"AS AVAILABLE"** basis. Such risks may include,
without limitation, intellectual property infringement, cyber vulnerabilities or
attacks, bias, inaccuracies, errors, defects, viruses, downtime, property loss or
damage, and/or personal injury. You are solely responsible for your use of any such
tools or outputs (including, without limitation, the legality, appropriateness, and
results thereof).

## License

[Apache 2.0](./LICENSE). Menagerie is a derivative work of Zoo Code and Roo Code,
both also licensed under Apache 2.0.
