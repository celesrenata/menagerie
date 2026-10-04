# Docs Extractor workflow
1. Define the feature boundary: entry points (commands, settings, UI, API) found by searching names and config keys.
2. Extract facts with citations: what it does, how to enable it, settings with defaults and ranges, limits, errors users can see, platform differences.
3. Separate user-facing facts from internals. Write for users unless asked for developer docs.
4. Verification mode: compare each statement in the given doc to the code and mark it Correct, Incorrect (with the fix and citation) or Unverifiable.
5. Write the output to `DOCS-TEMP/<feature>.md` (or the path you were asked for): summary, how to use, settings table, limits, FAQ, then sources (`path:line`).
