# OmniRoute Capacity-Cascade Design Correction

The requirements and design were corrected in place for the authoritative concurrent-capacity cascade and 60-second cloud timeout.

- **Finding 1 — scope:** Resolved. The requirements now explicitly authorize only the six named OmniRoute runtime files, focused tests, candidate image build, immutable-digest deployment, and rollback. Both artifacts require locating the clean/current canonical checkout before editing and prohibit unrelated source changes, changelogs, changesets, commits, and pushes.
- **Finding 2 — numeric zero:** Resolved. The design cites `open-sse/services/comboConfig.ts:275-278` and records that `resolveComboQueueDepth` converts with `Number`, defaults only non-finite/negative values, then floors/clamps, so numeric zero remains zero. Requirements and design mandate POST/PUT persistence/readback and dispatch tests proving `queued: 0` plus immediate cascade at both combo-local and shared-account gates for the 4070 and GLM paths.
- **Finding 3 — sequencing:** Resolved. Isolated candidate development/test/build occurs first. The timestamped mode-`0600` backup is the first production-host mutation and must validate before candidate deployment; the sole subsequent order is candidate digest deployment, durable/live policy application, then canaries. Any failed gate restores live records, durable policy, and the old immutable runtime digest.
- **Cloud timeout:** Every one of the 44 `pool/tier2-5/*` pools is specified at exactly `targetTimeoutMs: 60000` in live and durable policy, while local tier1/tier1b and roots remain at `600000` ms.

Verification found zero references to the superseded numeric timeout value in `requirements.md` or `design.md`.