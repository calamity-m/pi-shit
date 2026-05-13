# BIGPLAN: Tiered Subagents

## Plan Overview

This effort adds ephemeral isolated subagents to the personal Pi package and gives both the parent agent and subagents a stable model-tier vocabulary: `lightning`, `fast`, `default`, `strong`, and `oracle`. The chosen architecture is **shared code plus shared config**: a model-tiers extension owns the human-facing `/tier` and `/tiers` commands, while the subagents extension consumes the same tier resolver instead of depending on the command implementation. Done means a user can configure tier-to-model mappings, switch the parent session by tier, and let the parent agent spawn visible isolated subagent runs by tier without polluting the parent session beyond the final tool result. The `default` tier tracks the model a user chooses through Pi's normal model-selection flow, so `/model` remains the source of truth for the everyday default model.

## Risks

- **SDK resource recursion** — If subagent sessions use default resource discovery, they may load the subagents extension and allow recursive subagent spawning. Mitigate by constructing subagent SDK sessions with explicit in-memory session managers, explicit tool sets, and no auto-loaded project/global extensions for the MVP.
- **Tier config drift** — The `/tiers` UI and `spawn_subagent` tool must resolve tiers through the same code path, or a tier could switch the parent model differently from a subagent model. Mitigate with one shared helper module that owns load/save/validate/resolve behavior.
- **Model resolution ambiguity** — Friendly names and fuzzy model matching can select the wrong model when providers expose similarly named entries. Mitigate by storing canonical `provider/model-id` values in config and treating fuzzy search as UI-only selection assistance.
- **Unavailable tier models** — A configured tier can point at a model that is not available because the provider is logged out, an API key is missing, or the model ID changed. Mitigate by validating tiers against `modelRegistry.getAvailable()` in `/tiers`, showing clear errors, and making `spawn_subagent` fail fast with a useful tool error.
- **Config scope surprise** — Project-local and global tier files can disagree, making a tier behave differently across directories. Mitigate by always displaying the source path in `/tiers` and status/details UI, and by making save scope explicit.
- **Default-tier feedback loop** — Programmatic changes from `/tier strong` also emit model-selection events, so a naive listener could overwrite the `default` tier with every tier switch. Mitigate with an internal guard around extension-initiated model changes and only update `default` for normal user-driven selection flows.
- **Context pollution** — Status, transcripts, and intermediate subagent activity can accidentally enter the parent LLM context if implemented as messages. Mitigate by using temporary UI (`setStatus`, `setWidget`, `ctx.ui.custom`) for observability and returning only the final subagent result as the tool result.

## Plan Details

### Architecture Decision

Use option 2: **shared code plus shared config**.

Rejected options:

- Mega extension — simpler dependency graph, but combines two concepts that should evolve separately: model-tier management and subagent orchestration.
- Event bus as primary dependency — useful for live notifications later, but too implicit for the core dependency. If the tiers extension is not loaded, the subagent extension should still resolve tiers from config.

The event bus can be added later for live cache invalidation or status broadcasts, but the MVP contract is the config file and shared resolver.

### Default Tier and Pi's `/model`

Pi does not expose a hook for replacing or intercepting the built-in `/model` UI output, but extensions can subscribe to `model_select`. That event fires when the active model changes via `/model`, Ctrl+P cycling, or session restore. The tier extension should use this event to keep the `default` tier aligned with normal Pi model selection.

Implementation rule:

```text
user runs /model or cycles model
  -> model_select fires
  -> if change was not initiated by /tier <non-default>
       save/update default tier to selected provider/model
       preserve or update default thinkingLevel from current Pi thinking level
```

The extension must guard its own programmatic model changes:

```text
/tier strong
  -> set internal suppressDefaultUpdate flag
  -> pi.setModel(strong.model)
  -> pi.setThinkingLevel(strong.thinkingLevel)
  -> model_select fires but does not rewrite default
  -> clear flag

/tier default
  -> resolves current default tier and applies it
  -> does not need to rewrite default unless thinking level changed intentionally
```

This keeps `/model` useful and unsurprising: users can keep selecting their normal working model the Pi way, and subagents that ask for `modelTier: "default"` inherit that configured default.

### Proposed Files

```text
extensions/shared/model-tiers.ts
extensions/model-tiers/index.ts
extensions/subagents/index.ts
```

The shared module is not a Pi extension. It is ordinary TypeScript imported by both extensions.

### Tier Config Shape

Use canonical model IDs in config:

```json
{
  "lightning": { "model": "anthropic/claude-3-5-haiku-latest", "thinkingLevel": "off" },
  "fast": { "model": "openai/gpt-5-mini", "thinkingLevel": "minimal" },
  "default": { "model": "anthropic/claude-sonnet-4-5", "thinkingLevel": "medium" },
  "strong": { "model": "anthropic/claude-opus-4-5", "thinkingLevel": "high" },
  "oracle": { "model": "openai/gpt-5", "thinkingLevel": "xhigh" }
}
```

A tier resolves to:

```ts
type ResolvedModelTier = {
	tier: ModelTierName;
	model: Model<any>;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
};
```

### Config Location

Prefer project-local config first, then global fallback:

```text
.pi/model-tiers.json
~/.pi/agent/model-tiers.json
```

For writes, `/tiers` should make the scope explicit before saving. The MVP may default to project-local if this package is primarily project experimentation, but the command UI should show where it is reading from.

### Subagent Tool Input

Prefer tier vocabulary for normal use, with raw model escape hatch:

```ts
type SpawnSubagentInput = {
	task: string;
	modelTier?: "lightning" | "fast" | "default" | "strong" | "oracle";
	model?: string;
	thinkingLevel?: ThinkingLevel;
	role?: string;
	context?: string;
	files?: string[];
	tools?: "none" | "read-only" | "coding";
	outputFormat?: string;
};
```

Resolution order:

1. `model` + optional `thinkingLevel` if raw override is provided.
2. `modelTier` if provided.
3. `default` tier if configured.
4. Parent `ctx.model` and current thinking level as final fallback.

### Human Observability

The subagents extension should expose status without persistent messages:

```text
footer status: 2 subagents running, 1 done
widget row:    ● a17 reviewer strong reading extensions/foo.ts
/subagents:    detailed temporary panel with transcript/final-result view
```

### Critical Files

- `package.json` — Pi package manifest; new directory-based extensions under `extensions/` are auto-discovered from here.
- `extensions/README.md` — documents the directory-per-extension convention used in this repo.
- `extensions/shared/model-tiers.ts` — proposed shared contract for tier config loading, validation, saving, and resolution.
- `extensions/model-tiers/index.ts` — proposed human-facing commands for `/tier` and `/tiers`.
- `extensions/subagents/index.ts` — proposed `spawn_subagent` tool, `/subagents` UI, and subagent run registry.
- `TEMP.md` — scratch notes captured from the initial design discussion; useful source material but not the long-term plan.

### Gotchas

- Extension commands are not a stable dependency API. The subagents extension should not call `/tier`; it should import the shared resolver.
- `pi.events` is good for optional live coordination, but a missing listener should not break model-tier resolution.
- Built-in `/model` is not currently exposed as an overridable UI hook. Tier commands should live beside `/model`, not replace it.
- Use tool factory functions such as `createReadOnlyTools(ctx.cwd)` and `createCodingTools(ctx.cwd)` for subagent sessions so paths resolve against the project cwd.
- Do not use `pi.sendMessage()` for status updates because those messages can become parent-session context.

### Pseudo-code / Sketches

```text
/tier strong
  tiers = loadModelTiers(cwd, agentDir)
  resolved = resolveModelTier(tiers, "strong", ctx.modelRegistry)
  pi.setModel(resolved.model)
  pi.setThinkingLevel(resolved.thinkingLevel)
  ctx.ui.setStatus("tier", "strong · provider/model:thinking")

spawn_subagent({ task, modelTier: "strong", tools: "read-only" })
  resolved = resolveSubagentModel(input, tiers, ctx)
  run = createSubagentRunRecord(resolved)
  ctx.ui.setWidget("subagents", renderRuns())
  session = createAgentSession({
    cwd: ctx.cwd,
    sessionManager: SessionManager.inMemory(),
    model: resolved.model,
    thinkingLevel: resolved.thinkingLevel,
    tools: createReadOnlyTools(ctx.cwd),
    resourceLoader: noAutoExtensionsLoader,
  })
  subscribe(session events -> update run status/widget)
  await session.prompt(buildSubagentPrompt(input))
  return final assistant text as tool result
```

## Deliverables

### Deliverable 1. Shared model-tier contract

Create the shared TypeScript module that defines tier names, config shape, validation, file discovery, save behavior, and model resolution. This is the core dependency between tier management and subagents; both extensions must use it instead of duplicating parsing or model lookup logic.

- [x] Create `extensions/shared/model-tiers.ts` with tier types and constants.
- [x] Implement project/global config path discovery.
- [x] Implement load/save helpers with clear errors for missing or invalid config.
- [x] Implement canonical `provider/model-id` parsing and `ctx.modelRegistry` resolution.
- [x] Implement helpers to update only the `default` tier from the currently selected Pi model/thinking level.
- [x] Implement availability validation that distinguishes unknown model IDs from missing provider auth.
- [x] Add a small default empty/config template helper for `/tiers` to use.

### Deliverable 2. Human-facing tier commands

Create a `model-tiers` extension that lets the user view, configure, and use model tiers for the parent Pi session. This should complement Pi's built-in `/model` UI, not replace it.

- [x] Create `extensions/model-tiers/index.ts`.
- [x] Register `/tier <name>` to switch the parent model and thinking level by tier.
- [x] Subscribe to `model_select` so normal Pi model selection updates the `default` tier.
- [x] Subscribe to `thinking_level_select` so default-tier thinking stays aligned when appropriate.
- [x] Guard extension-initiated `/tier <non-default>` switches so they do not overwrite the `default` tier.
- [x] Register `/tiers` to show current tier mappings, validation status, and config source.
- [x] Provide a minimal edit/setup path for tier mappings, either via temporary editor UI or by opening/prefilling JSON.
- [x] Make save target explicit when writing tier config: project-local or global.
- [x] Show current tier status in the footer when the active model matches a configured tier.
- [x] Document the tier commands in `README.md`.

### Deliverable 3. Ephemeral subagent runner

Create the subagents extension with a `spawn_subagent` tool that starts isolated in-memory SDK sessions and returns only the final result to the parent agent. The runner should resolve `modelTier` through the shared module and support raw model override only as an escape hatch.

- [x] Create `extensions/subagents/index.ts`.
- [x] Register `spawn_subagent` with `modelTier`, raw `model`, `thinkingLevel`, task/context/files, tool policy, and output format fields.
- [x] Return a clear tool error when the requested tier/model cannot be resolved or is not authenticated.
- [x] Build isolated SDK sessions with `SessionManager.inMemory()`.
- [x] Select explicit tools from `none`, `read-only`, and `coding` policies using SDK active-tool allowlists bound to the subagent cwd.
- [x] Prevent recursive extension loading in subagent sessions for the MVP.
- [x] Return final assistant text as the tool result and avoid persisting intermediate transcript into the parent session.

### Deliverable 4. Subagent observability UI

Add the human-visible status required to trust background subagent activity. Status should be temporary UI state, not session messages.

- [x] Maintain an in-memory registry of active/completed subagent runs.
- [x] Subscribe to SDK session events and update run status/current activity.
- [x] Show compact footer status via `ctx.ui.setStatus("subagents", ...)`.
- [x] Show a compact widget with active/completed runs via `ctx.ui.setWidget("subagents", ...)`.
- [x] Register `/subagents` to open a temporary detailed panel.
- [x] Add abort support if the SDK session abort path is straightforward; otherwise log it as a deferred issue.

### Deliverable 5. Verification and documentation

Typecheck the changed extension files and document the manual flows needed to verify model tiers and subagents in Pi's interactive UI.

- [ ] Typecheck shared/tier/subagent files with targeted `tsc` commands.
- [ ] Manually verify `/tiers` displays config and `/tier <name>` switches model/thinking.
- [ ] Manually verify `spawn_subagent` can run with at least one configured tier.
- [ ] Manually verify subagent status appears without adding status messages to the parent session.
- [ ] Update `README.md` with install/test commands and expected commands.

## Issues

- **2026-05-13 — agent:claude** — Changed subagent widget lifecycle: live widget/status show while runs are active, linger for 8 seconds after completion, clear immediately on the next user input when idle, and clear on session shutdown while preserving `/subagents` in-memory history.
- **2026-05-13 — agent:claude** — Updated `spawn_subagent.files` semantics: listed files are now preloaded into the subagent prompt with fixed size caps, rather than only being path hints the subagent must immediately read.
- **2026-05-13 — agent:claude** — Implemented Deliverable 4 MVP. Subagent runs are tracked in memory, update footer/widget UI from SDK events, expose `/subagents` as a temporary panel, and abort the nested SDK session when the parent tool signal aborts.
- **2026-05-13 — agent:claude** — Implemented Deliverable 3 MVP. Subagent sessions use `SessionManager.inMemory()`, explicit active tool name allowlists, and a `DefaultResourceLoader` with `noExtensions: true`; current Pi SDK binds built-in tools to `cwd` from `createAgentSession`, so no separate tool factory objects are passed.
- **2026-05-13 — agent:claude** — Resolved Deliverable 3 SDK question: recursive extension loading can be disabled with `DefaultResourceLoader({ noExtensions: true })` for the subagent session.
- **2026-05-13 — agent:claude** — Changed `/tiers` default write behavior: when no tier config exists yet, the interactive picker now creates global `~/.pi/agent/model-tiers.json` instead of project-local `.pi/model-tiers.json`.
- **2026-05-13 — agent:claude** — Changed `/tiers` from report-first to interactive configuration: tier picker -> authenticated model picker -> supported thinking-level picker. `/tiers show` keeps the old report and `/tiers edit` remains the raw JSON escape hatch.
- **2026-05-13 — agent:claude** — Updated plan so the `default` tier tracks Pi's normal `/model` selection via `model_select`/`thinking_level_select`, with a guard against `/tier <non-default>` feedback loops.
- **2026-05-13 — agent:claude (adversarial review)** — Plan reviewed with Risks & Assumptions and Completeness & Scope passes. 3 findings; 3 merged into plan. Main changes: added unavailable-model and config-scope risks, plus validation/save-scope tasks.
- **2026-05-13 — agent:claude** — Open question for Deliverable 2: the exact `/tiers` editing UX is not decided. The smallest version can show config path and paste a JSON template into the editor; a richer temporary settings UI can come later.
- **2026-05-13 — agent:claude** — Open question for Deliverable 3: the exact SDK option for disabling auto-loaded extensions needs to be confirmed during implementation against Pi's current `createAgentSession`/`ResourceLoader` APIs.
