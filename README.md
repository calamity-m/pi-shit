# pi-shit

Personal pi package repo.

## Layout

```text
extensions/
  <extension-name>/
    index.ts
prompts/
themes/
skills/
```

Keep extensions directory-based so loose TypeScript files do not pile up.

## Try locally

```bash
pi -e .
```

Tip: set `quietStartup: true` in Pi settings if you want the custom dashboard header without Pi's built-in startup resource listing.

## Extensions

- `/pi-shit` confirms the package is loaded.
- `/context` shows a Claude Code-style context report: current usage, system prompt size, context files, skills, tools, prompt templates, extension commands, and largest session entries.
- `/skills` opens a temporary searchable browser of available skills grouped by source.
- `/clear` starts a fresh session and clears the visible conversation without deleting the old session file.

## Install locally

```bash
pi install /home/calam/code/pi-shit
```
