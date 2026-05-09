# Prompt Extension Production Notes

This document captures the main gaps to address before treating `extensions/prompt` as production-quality code.

## Biggest gaps

1. **Tests for core string logic**

   Add focused tests for:

   - `parseFrontmatter`
   - `splitArgs`
   - `expandPrompt`
   - `promptLabel`

   These helpers are where subtle regressions are most likely: quoting, escaped spaces, multiline arguments, `$10`, missing positional arguments, and literal dollar signs.

2. **Better frontmatter parsing**

   The current parser only supports simple `key: value` lines. It does not fully handle YAML features such as multiline values, comments, Windows line endings, colons inside quoted values, arrays, or booleans.

   Production options:

   - use a real frontmatter/YAML parser; or
   - explicitly document that only simple one-line string frontmatter is supported.

   If the goal is parity with Pi's native prompt-template behavior, the extension should either reuse the same parser or mirror its documented behavior closely.

3. **Validation and useful errors**

   Several failure paths are currently silent or easy to miss. Production behavior should surface diagnostics for:

   - unreadable prompt files;
   - missing `sourceInfo.path`;
   - malformed frontmatter;
   - unknown requested prompt names;
   - duplicate prompt names;
   - unsupported or suspicious placeholders.

4. **Stronger selection identity**

   The picker currently displays formatted labels and then extracts the prompt name back out with a regex. That makes display text part of the identity contract.

   A more robust version should keep identity separate from presentation. If `ctx.ui.select` only returns strings, maintain a `Map<label, prompt>` or use a stable internal label prefix that cannot collide.

5. **Deliberate direct-invocation behavior**

   `/prompt foo args` currently opens the multiline editor before expansion, even when arguments were supplied.

   That may be the desired behavior, but production should make the contract explicit:

   - always open the editor so the user can review/edit arguments; or
   - expand immediately when arguments are supplied; or
   - support an explicit edit mode later if needed.

   Avoid adding flags until there is a clear need.

6. **Documented placeholder contract**

   Current supported placeholders:

   - `$ARGUMENTS`
   - `$@`
   - `$1`, `$2`, ...
   - `${@:N}`
   - `${@:N:L}`

   Production docs/tests should define:

   - quoting and escaping rules;
   - behavior for missing arguments;
   - behavior for literal dollar signs;
   - `$10` semantics;
   - slice bounds and zero/negative values.

7. **Non-interactive and cancellation behavior**

   The command is UI-oriented and uses `ctx.ui.editor`. Production code should still be clear about what happens when interactive UI is unavailable, and should handle cancellation without side effects.

8. **Packaging/runtime dependency hygiene**

   This repo is currently a personal Pi package, so local dependency layout is acceptable. If publishing, runtime imports should be available through `dependencies` or explicitly documented peer dependencies. Pi package installs may omit `devDependencies`.

## Suggested first production pass

Keep the extension small. The main risk is parsing correctness and silent failure, not architecture.

Recommended order:

1. Add focused tests for `splitArgs` and `expandPrompt`.
2. Replace silent read failures with visible diagnostics.
3. Make prompt selection identity independent of display text.
4. Decide and document whether `/prompt foo args` should always open the editor.

Avoid a broad modular refactor unless the extension grows beyond this command.
