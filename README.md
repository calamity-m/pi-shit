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

## Extensions

- `/pi-shit` confirms the package is loaded.
- `/context` shows a Claude Code-style context report: current usage, system prompt size, context files, skills, tools, prompt templates, extension commands, and largest session entries.

## Install locally

```bash
pi install /home/calam/code/pi-shit
```
