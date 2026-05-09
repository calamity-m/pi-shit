# Agent Instructions

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State assumptions explicitly when the request is ambiguous.
- If multiple interpretations exist, present them instead of choosing silently.
- The user is still learning Pi; explain Pi-specific behavior briefly and push back on changes that conflict with how Pi extensions, skills, prompts, themes, or sessions actually work.
- Push back when requested changes seem contradictory, especially UX changes that would reintroduce context pollution, persistent session entries, or surprising agent behavior.
- Don't expand into packaging, publishing, broad refactors, or adjacent features unless asked.
- If something is unclear, stop, name the confusion, and ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No configurability until the user asks for it.
- Prefer a small extension command or UI component over a generalized framework.
- If a change can be 50 lines instead of 200, make it 50.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Match the local TypeScript style: tabs, concise helpers, directory-based extensions.
- Do not refactor unrelated extension code.
- Do not format entire files unless the edit requires it.
- If you notice unrelated dead code or design issues, mention them instead of changing them.

When your changes create orphans:
- Remove imports, variables, or helpers made unused by your change.
- Do not remove pre-existing dead code unless asked.

Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

For multi-step tasks, state a brief plan:

```text
1. Inspect the relevant extension and Pi API docs -> verify: identify the right command/UI hook.
2. Apply the smallest code change -> verify: diff only touches requested paths.
3. Typecheck the edited extension -> verify: `npx --yes --package typescript tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck <file>` passes.
```

Use concrete verification. For UI-only behavior that cannot be fully automated, still typecheck and describe the manual interaction to test.

## 5. In-Code Documentation

**Public API must be documented. Internal logic should explain the why.**

This repo is TypeScript. Use JSDoc only for exported functions, public classes, or non-obvious extension APIs. Internal helpers usually do not need comments unless they encode Pi-specific behavior or terminal rendering constraints.

Comment the why, not the what. Example: note when a command uses temporary UI specifically to avoid adding custom messages to context.

## 6. Pre-commit Hooks

**Prefer automated checks over repeated manual reminders.**

No pre-commit config is present. Before adding hooks, ask the user. Natural checks for this repo are:

```bash
npx --yes --package typescript tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck extensions/context/index.ts
```

If the repo grows, suggest a `tsconfig.json` plus a pre-commit hook that runs TypeScript typechecking for changed extension files.

## 7. Repository Map

### Key directories

```text
extensions/          -> Pi extension packages; each extension lives in its own directory with index.ts
extensions/context/  -> /context command and temporary TUI report panel
extensions/personal/ -> small personal utility commands
prompts/             -> Pi prompt templates exposed as slash commands when populated
skills/              -> Pi skills packaged with this repo when populated
themes/              -> Pi themes packaged with this repo when populated
```

### Entry points

```text
package.json                   -> Pi package manifest; `pi -e .` loads resources from this repo
extensions/context/index.ts    -> /context extension command
extensions/personal/index.ts   -> /pi-shit extension command
```

Launch locally with:

```bash
pi -e .
```

Install locally with:

```bash
pi install /home/calam/code/pi-shit
```

### Data flow

```text
pi -e . or installed package
  -> package.json pi.extensions/prompts/skills/themes
  -> extensions/*/index.ts registers commands/events/UI
  -> user invokes slash command
  -> extension reads Pi session/resource APIs and renders temporary UI or notifications
```

For `/context` specifically:

```text
/context command -> buildReport(ctx, pi, snapshot) -> ContextReportPanel via ctx.ui.custom()
```

Avoid `pi.sendMessage()` for inspection-only UI because custom messages can enter future LLM context.

## 8. Project-Specific Notes

- This is a personal Pi package, not Pi core; prefer extension-level solutions over core assumptions.
- The user is iterating on Pi UX and may not know Pi internals; explain constraints and challenge requests that fight Pi's session/context model.
- `/context` must not add persistent session messages; keep reports temporary unless explicitly asked otherwise.
- Directory-based extensions are preferred so loose TypeScript files do not pile up.
- `node_modules/` is present but should not be treated as project source.
- There is no repo-wide `tsconfig.json`; use targeted TypeScript checks unless/until one is added.

---

**These guidelines are working if:** diffs stay small, Pi-specific footguns are surfaced early, and inspection commands do not pollute the context they are meant to explain.
