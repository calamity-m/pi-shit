import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
	getAgentDir,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	MODEL_TIER_NAMES,
	THINKING_LEVELS,
	formatCanonicalModelId,
	isModelTierName,
	isModelTierThinkingLevel,
	loadModelTierConfig,
	parseCanonicalModelId,
	resolveModelTier,
	type ModelTierName,
} from "../shared/model-tiers.js";

const TOOL_POLICIES = ["none", "read-only", "coding"] as const;
const MAX_RECORDED_RUNS = 20;
const MAX_PRELOADED_FILE_CHARS = 20_000;
const MAX_PRELOADED_TOTAL_CHARS = 60_000;

const toolPolicyNames = {
	"none": [],
	"read-only": ["read", "grep", "find", "ls"],
	coding: ["read", "grep", "find", "ls", "bash", "edit", "write"],
} satisfies Record<(typeof TOOL_POLICIES)[number], string[]>;

const spawnSubagentSchema = Type.Object({
	task: Type.String({ description: "The isolated subagent task to run." }),
	modelTier: Type.Optional(Type.Union(MODEL_TIER_NAMES.map((tier) => Type.Literal(tier)))),
	model: Type.Optional(Type.String({ description: "Raw canonical model override, provider/model-id. Prefer modelTier for normal use." })),
	thinkingLevel: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))),
	role: Type.Optional(Type.String({ description: "Optional role/persona for the subagent." })),
	context: Type.Optional(Type.String({ description: "Extra context to provide to the subagent." })),
	files: Type.Optional(Type.Array(Type.String(), { description: "Relevant file paths for the subagent to inspect." })),
	tools: Type.Optional(Type.Union(TOOL_POLICIES.map((policy) => Type.Literal(policy)), { description: "Tool access policy. Defaults to read-only." })),
	outputFormat: Type.Optional(Type.String({ description: "Requested final answer format." })),
});

type SpawnSubagentInput = Static<typeof spawnSubagentSchema>;
type ToolPolicy = (typeof TOOL_POLICIES)[number];
type SubagentRunStatus = "queued" | "running" | "done" | "error" | "aborted";

type SubagentRun = {
	id: string;
	task: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
	modelSource: string;
	tools: ToolPolicy;
	status: SubagentRunStatus;
	currentActivity: string;
	finalText?: string;
	error?: string;
	startedAt: number;
	endedAt?: number;
};

type SubagentModelSelection = {
	model: Model<any>;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
	source: string;
};

class SubagentsPanel implements Focusable {
	focused = false;
	private scroll = 0;

	constructor(
		private readonly runs: SubagentRun[],
		private readonly tui: TUI,
		private readonly theme: any,
		private readonly done: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q") {
			this.done();
			return;
		}
		if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, "down")) this.scroll = Math.min(this.maxScroll(), this.scroll + 1);
		else if (matchesKey(data, "ctrl+u")) this.scroll = Math.max(0, this.scroll - 10);
		else if (matchesKey(data, "ctrl+d")) this.scroll = Math.min(this.maxScroll(), this.scroll + 10);
		else return;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const lines = buildSubagentsReport(this.runs);
		const innerWidth = Math.max(20, width - 2);
		const visibleRows = 28;
		this.scroll = Math.min(this.scroll, this.maxScroll(visibleRows, lines.length));
		const visible = lines.slice(this.scroll, this.scroll + visibleRows);
		const th = this.theme;
		const border = (text: string) => th.fg("border", text);
		const pad = (text: string) => {
			const truncated = truncateToWidth(text, innerWidth, "");
			return truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
		};
		const footer = ` Enter/Esc/q close · ↑/↓ scroll · ${Math.min(lines.length, this.scroll + 1)}-${Math.min(this.scroll + visibleRows, lines.length)}/${lines.length} `;

		return [
			border(`╭${"─".repeat(innerWidth)}╮`),
			`${border("│")}${pad(` ${th.fg("accent", th.bold("Subagents"))} ${th.fg("dim", "(temporary, not saved to message history)")}`)}${border("│")}`,
			`${border("│")}${pad("")}${border("│")}`,
			...visible.map((line) => `${border("│")}${pad(line)}${border("│")}`),
			...Array.from({ length: Math.max(0, visibleRows - visible.length) }, () => `${border("│")}${pad("")}${border("│")}`),
			border(`├${"─".repeat(innerWidth)}┤`),
			`${border("│")}${pad(th.fg("dim", footer))}${border("│")}`,
			border(`╰${"─".repeat(innerWidth)}╯`),
		];
	}

	invalidate(): void {}

	private maxScroll(visibleRows = 28, lineCount = buildSubagentsReport(this.runs).length): number {
		return Math.max(0, lineCount - visibleRows);
	}
}

export default function (pi: ExtensionAPI) {
	const runs: SubagentRun[] = [];
	let clearWidgetTimer: ReturnType<typeof setTimeout> | undefined;
	const updateUi = (ctx: ExtensionContext) => updateSubagentsUi(ctx, runs, () => clearWidgetTimer, (timer) => {
		clearWidgetTimer = timer;
	});

	pi.on("input", async (_event, ctx) => {
		if (!hasActiveRuns(runs)) {
			clearSubagentsWidget(ctx);
			if (clearWidgetTimer) clearTimeout(clearWidgetTimer);
			clearWidgetTimer = undefined;
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (clearWidgetTimer) clearTimeout(clearWidgetTimer);
		clearWidgetTimer = undefined;
		clearSubagentsWidget(ctx);
	});

	pi.registerCommand("subagents", {
		description: "Show active and recent isolated subagent runs",
		handler: async (_args, ctx) => {
			await ctx.ui.custom((tui, theme, _keybindings, done) => new SubagentsPanel(runs, tui, theme, () => done(undefined)));
		},
	});

	pi.registerTool({
		name: "spawn_subagent",
		label: "Spawn Subagent",
		description: "Run an isolated ephemeral Pi subagent and return only its final answer.",
		promptSnippet: "Run an isolated subagent for review, investigation, or parallel analysis tasks.",
		promptGuidelines: [
			"Use spawn_subagent for isolated investigation, review, or parallel analysis; pass modelTier instead of raw model unless the user asks for a specific model.",
			"spawn_subagent returns only the final subagent answer to the parent context; intermediate transcript is intentionally not persisted.",
		],
		parameters: spawnSubagentSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			let run: SubagentRun | undefined;
			try {
				const selection = await resolveSubagentModel(params, ctx, pi);
				const policy: ToolPolicy = (params.tools as ToolPolicy | undefined) ?? "read-only";
				run = createRun(params, selection, policy);
				runs.unshift(run);
				pruneRuns(runs);
				updateUi(ctx);

				onUpdate?.({
					content: [{ type: "text", text: `Starting subagent ${run.id} (${selection.source}, ${policy} tools)…` }],
					details: { id: run.id, model: selection.modelId, thinkingLevel: selection.thinkingLevel, tools: policy },
				});

				const loader = new DefaultResourceLoader({
					cwd: ctx.cwd,
					agentDir: getAgentDir(),
					noExtensions: true,
				});
				await loader.reload();

				const { session } = await createAgentSession({
					cwd: ctx.cwd,
					agentDir: getAgentDir(),
					model: selection.model,
					thinkingLevel: selection.thinkingLevel,
					modelRegistry: ctx.modelRegistry,
					resourceLoader: loader,
					sessionManager: SessionManager.inMemory(ctx.cwd),
					tools: toolPolicyNames[policy],
					noTools: policy === "none" ? "all" : undefined,
				});

				let finalText = "";
				const unsubscribe = session.subscribe((event) => {
					if (!run) return;
					handleSubagentEvent(run, event);
					if (event.type === "agent_end") finalText = extractFinalAssistantText(event.messages);
					updateUi(ctx);
				});
				try {
					if (signal?.aborted) throw new Error("Subagent aborted before start.");
					const abort = () => {
						if (!run) return;
						run.status = "aborted";
						run.currentActivity = "aborting";
						run.endedAt = Date.now();
						updateUi(ctx);
						void session.abort();
					};
					signal?.addEventListener("abort", abort, { once: true });
					try {
						const preloadedFiles = await preloadFiles(ctx.cwd, params.files);
						await session.prompt(buildSubagentPrompt(params, preloadedFiles), { source: "extension" });
					} finally {
						signal?.removeEventListener("abort", abort);
					}
				} finally {
					unsubscribe();
					session.dispose();
				}

				const text = finalText.trim() || "Subagent completed without a final text response.";
				run.status = run.status === "aborted" ? "aborted" : "done";
				run.currentActivity = run.status;
				run.finalText = text;
				run.endedAt = Date.now();
				updateUi(ctx);
				return {
					content: [{ type: "text", text }],
					details: { id: run.id, model: selection.modelId, thinkingLevel: selection.thinkingLevel, tools: policy },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (run) {
					run.status = signal?.aborted ? "aborted" : "error";
					run.currentActivity = run.status;
					run.error = message;
					run.endedAt = Date.now();
					updateUi(ctx);
				}
				return {
					content: [{ type: "text", text: message }],
					details: { id: run?.id, error: message },
					isError: true,
				};
			}
		},
	});
}

async function resolveSubagentModel(
	input: SpawnSubagentInput,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): Promise<SubagentModelSelection> {
	if (input.model) {
		const parsed = parseCanonicalModelId(input.model);
		const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
		if (!model) throw new Error(`Unknown model: ${input.model}`);
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`Model is known but unavailable; authenticate provider "${parsed.provider}" or configure its API key: ${input.model}`);
		return {
			model,
			modelId: input.model,
			thinkingLevel: normalizeThinkingLevel(input.thinkingLevel),
			source: "raw model override",
		};
	}

	const loaded = await loadModelTierConfig(ctx.cwd);
	const tier = normalizeTier(input.modelTier);
	if (tier) {
		if (!loaded.config[tier]) throw new Error(`No model configured for tier "${tier}"`);
		const resolved = resolveModelTier(loaded.config, tier, ctx.modelRegistry);
		return {
			model: resolved.model,
			modelId: resolved.modelId,
			thinkingLevel: normalizeThinkingLevel(input.thinkingLevel ?? resolved.thinkingLevel),
			source: `tier ${tier}`,
		};
	}

	if (loaded.config.default) {
		const resolved = resolveModelTier(loaded.config, "default", ctx.modelRegistry);
		return {
			model: resolved.model,
			modelId: resolved.modelId,
			thinkingLevel: normalizeThinkingLevel(input.thinkingLevel ?? resolved.thinkingLevel),
			source: "tier default",
		};
	}

	if (!ctx.model) throw new Error("No subagent model configured and parent session has no active model.");
	return {
		model: ctx.model,
		modelId: formatCanonicalModelId(ctx.model),
		thinkingLevel: normalizeThinkingLevel(input.thinkingLevel ?? pi.getThinkingLevel()),
		source: "parent fallback",
	};
}

function normalizeTier(value: string | undefined): ModelTierName | undefined {
	if (value == null) return undefined;
	if (!isModelTierName(value)) throw new Error(`Invalid modelTier: ${value}`);
	return value;
}

function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	if (value == null) return undefined;
	if (!isModelTierThinkingLevel(value)) throw new Error(`Invalid thinkingLevel: ${value}`);
	return value;
}

function createRun(input: SpawnSubagentInput, selection: SubagentModelSelection, tools: ToolPolicy): SubagentRun {
	return {
		id: `sa-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`,
		task: input.task,
		modelId: selection.modelId,
		thinkingLevel: selection.thinkingLevel,
		modelSource: selection.source,
		tools,
		status: "queued",
		currentActivity: "queued",
		startedAt: Date.now(),
	};
}

function handleSubagentEvent(run: SubagentRun, event: AgentSessionEvent): void {
	switch (event.type) {
		case "agent_start":
			run.status = "running";
			run.currentActivity = "starting";
			break;
		case "turn_start":
			run.currentActivity = "thinking";
			break;
		case "message_update":
			if (event.assistantMessageEvent.type === "text_delta") run.currentActivity = "responding";
			break;
		case "tool_execution_start":
			run.currentActivity = `using ${event.toolName}`;
			break;
		case "tool_execution_end":
			run.currentActivity = `${event.toolName} ${event.isError ? "error" : "done"}`;
			break;
		case "agent_end":
			run.status = "done";
			run.currentActivity = "done";
			run.endedAt = Date.now();
			break;
	}
}

function updateSubagentsUi(
	ctx: ExtensionContext,
	runs: SubagentRun[],
	getClearWidgetTimer: () => ReturnType<typeof setTimeout> | undefined,
	setClearWidgetTimer: (timer: ReturnType<typeof setTimeout> | undefined) => void,
): void {
	const active = runs.filter((run) => run.status === "queued" || run.status === "running");
	const done = runs.filter((run) => run.status === "done").length;
	const existingTimer = getClearWidgetTimer();
	if (existingTimer) {
		clearTimeout(existingTimer);
		setClearWidgetTimer(undefined);
	}

	if (active.length > 0) {
		ctx.ui.setStatus("subagents", `${active.length} subagent${active.length === 1 ? "" : "s"} running, ${done} done`);
		ctx.ui.setWidget("subagents", buildSubagentWidget(runs), { placement: "aboveEditor" });
		return;
	}

	ctx.ui.setStatus("subagents", undefined);
	ctx.ui.setWidget("subagents", buildSubagentWidget(runs), { placement: "aboveEditor" });
	setClearWidgetTimer(setTimeout(() => {
		ctx.ui.setWidget("subagents", undefined);
		setClearWidgetTimer(undefined);
	}, 8000));
}

function clearSubagentsWidget(ctx: ExtensionContext): void {
	ctx.ui.setStatus("subagents", undefined);
	ctx.ui.setWidget("subagents", undefined);
}

function hasActiveRuns(runs: SubagentRun[]): boolean {
	return runs.some((run) => run.status === "queued" || run.status === "running");
}

function buildSubagentWidget(runs: SubagentRun[]): string[] | undefined {
	if (runs.length === 0) return undefined;
	return runs.slice(0, 5).map((run) => `${statusIcon(run.status)} ${run.id} ${run.modelSource} ${run.currentActivity} — ${truncate(run.task, 72)}`);
}

function buildSubagentsReport(runs: SubagentRun[]): string[] {
	if (runs.length === 0) return ["No subagent runs recorded in this extension runtime."];
	return runs.flatMap((run) => [
		`${statusIcon(run.status)} ${run.id} ${run.status.toUpperCase()} · ${run.modelSource} · ${run.modelId}${run.thinkingLevel ? `:${run.thinkingLevel}` : ""} · tools:${run.tools}`,
		`task: ${truncate(run.task, 140)}`,
		`activity: ${run.currentActivity} · elapsed: ${formatElapsed(run)}`,
		...(run.error ? [`error: ${truncate(run.error, 160)}`] : []),
		...(run.finalText ? [`final: ${truncate(run.finalText, 220)}`] : []),
		"",
	]);
}

function pruneRuns(runs: SubagentRun[]): void {
	if (runs.length <= MAX_RECORDED_RUNS) return;
	runs.splice(MAX_RECORDED_RUNS);
}

function statusIcon(status: SubagentRunStatus): string {
	if (status === "queued") return "○";
	if (status === "running") return "●";
	if (status === "done") return "✓";
	if (status === "aborted") return "■";
	return "!";
}

function formatElapsed(run: SubagentRun): string {
	const end = run.endedAt ?? Date.now();
	return `${Math.max(0, Math.round((end - run.startedAt) / 1000))}s`;
}

function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

async function preloadFiles(cwd: string, files: string[] | undefined): Promise<string[]> {
	if (!files?.length) return [];
	let total = 0;
	const blocks: string[] = [];
	for (const file of files) {
		const path = isAbsolute(file) ? file : resolve(cwd, file);
		try {
			const raw = await readFile(path, "utf8");
			const remaining = Math.max(0, MAX_PRELOADED_TOTAL_CHARS - total);
			const content = raw.slice(0, Math.min(MAX_PRELOADED_FILE_CHARS, remaining));
			total += content.length;
			const truncated = content.length < raw.length ? `\n[truncated: ${raw.length - content.length} chars omitted]` : "";
			blocks.push(`### ${file}\n\`\`\`\n${content}${truncated}\n\`\`\``);
			if (total >= MAX_PRELOADED_TOTAL_CHARS) break;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			blocks.push(`### ${file}\n[Could not preload file: ${message}]`);
		}
	}
	return blocks;
}

function buildSubagentPrompt(input: SpawnSubagentInput, preloadedFiles: string[]): string {
	const parts = [
		"You are an isolated ephemeral subagent spawned by a parent Pi session.",
		"Work independently. Do not assume access to the parent conversation beyond the context below.",
		"Return a concise final answer for the parent agent. Do not mention hidden chain-of-thought.",
	];
	if (input.role) parts.push(`\nRole:\n${input.role}`);
	if (input.context) parts.push(`\nContext:\n${input.context}`);
	if (preloadedFiles.length) parts.push(`\nPreloaded files:\n${preloadedFiles.join("\n\n")}`);
	if (input.files?.length) parts.push(`\nRelevant file paths:\n${input.files.map((file) => `- ${file}`).join("\n")}`);
	if (input.outputFormat) parts.push(`\nOutput format:\n${input.outputFormat}`);
	parts.push(`\nTask:\n${input.task}`);
	return parts.join("\n");
}

function extractFinalAssistantText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as Partial<AssistantMessage>;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		return message.content
			.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof (part as { text?: unknown }).text === "string")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}
