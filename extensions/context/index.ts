import {
	formatSkillsForPrompt,
	parseSkillBlock,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Focusable, type TUI } from "@earendil-works/pi-tui";

type Snapshot = {
	systemPrompt: string;
	options: BuildSystemPromptOptions;
	capturedAt: number;
};

type BreakdownItem = {
	label: string;
	tokens: number;
	detail?: string;
};

const CUSTOM_TYPE = "context-report";

class ContextReportPanel implements Focusable {
	focused = false;
	private scroll = 0;
	private readonly lines: string[];

	constructor(
		report: string,
		private tui: TUI,
		private theme: any,
		private done: () => void,
	) {
		this.lines = report.split("\n");
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q") {
			this.done();
			return;
		}

		if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, "down")) this.scroll = Math.min(this.maxScroll(), this.scroll + 1);
		else if (matchesKey(data, "ctrl+u")) this.scroll = Math.max(0, this.scroll - 10);
		else if (matchesKey(data, "ctrl+d")) this.scroll = Math.min(this.maxScroll(), this.scroll + 10);
		else if (matchesKey(data, "home")) this.scroll = 0;
		else if (matchesKey(data, "end")) this.scroll = this.maxScroll();
		else return;

		this.tui.requestRender();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(20, width - 2);
		const visibleRows = 34;
		const maxScroll = this.maxScroll(visibleRows);
		this.scroll = Math.min(this.scroll, maxScroll);
		const visible = this.lines.slice(this.scroll, this.scroll + visibleRows);
		const th = this.theme;
		const border = (text: string) => th.fg("border", text);
		const pad = (text: string) => {
			const truncated = truncateToWidth(text, innerWidth, "");
			return truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
		};
		const footer = ` Enter/Esc/q close · ↑/↓ scroll · Ctrl+u/d page · ${this.scroll + 1}-${Math.min(this.scroll + visibleRows, this.lines.length)}/${this.lines.length} `;

		return [
			border(`╭${"─".repeat(innerWidth)}╮`),
			`${border("│")}${pad(` ${th.fg("accent", th.bold("Context report"))} ${th.fg("dim", "(temporary, not saved to message history)")}`)}${border("│")}`,
			`${border("│")}${pad("")}${border("│")}`,
			...visible.map((line) => `${border("│")}${pad(line)}${border("│")}`),
			...Array.from({ length: Math.max(0, visibleRows - visible.length) }, () => `${border("│")}${pad("")}${border("│")}`),
			border(`├${"─".repeat(innerWidth)}┤`),
			`${border("│")}${pad(th.fg("dim", footer))}${border("│")}`,
			border(`╰${"─".repeat(innerWidth)}╯`),
		];
	}

	invalidate(): void {}

	private maxScroll(visibleRows = 34): number {
		return Math.max(0, this.lines.length - visibleRows);
	}
}

function estimateTokens(value: unknown): number {
	const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
	return Math.max(0, Math.ceil(text.length / 4));
}

function fmt(n: number | null | undefined): string {
	return n == null ? "?" : n.toLocaleString();
}

function pct(tokens: number, total: number | null | undefined): string {
	if (!total || total <= 0) return "?";
	return `${((tokens / total) * 100).toFixed(1)}%`;
}

function pad(text: string, width: number, align: "left" | "right" = "left"): string {
	const value = text.length > width ? `${text.slice(0, width - 1)}…` : text;
	return align === "right" ? value.padStart(width) : value.padEnd(width);
}

function table(headers: string[], rows: string[][]): string[] {
	const widths = headers.map((header, i) =>
		Math.min(48, Math.max(header.length, ...rows.map((row) => String(row[i] ?? "").length))),
	);
	const format = (row: string[]) => row.map((cell, i) => pad(String(cell ?? ""), widths[i], i === 1 ? "right" : "left")).join("  ");
	return [format(headers), widths.map((w) => "─".repeat(w)).join("  "), ...rows.map(format)];
}

function bar(tokens: number, total: number | null | undefined, width = 16): string {
	if (!total || total <= 0) return "?".padEnd(width);
	const filled = Math.max(0, Math.min(width, Math.round((tokens / total) * width)));
	return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function truncate(text: string, max = 120): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content ?? "");
	return content
		.map((part) => {
			if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
				return part.text;
			}
			if (part && typeof part === "object" && "type" in part) {
				return `[${String(part.type)}]`;
			}
			return JSON.stringify(part);
		})
		.join("\n");
}

function entrySummary(entry: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]>[number]): {
	label: string;
	text: string;
} {
	if (entry.type === "message") {
		const message = entry.message as { role?: string; content?: unknown };
		return { label: `message:${message.role ?? "unknown"}`, text: contentToText(message.content) };
	}
	if (entry.type === "custom_message") {
		return { label: `custom:${entry.customType}`, text: contentToText(entry.content) };
	}
	if (entry.type === "compaction") {
		return { label: "compaction", text: entry.summary };
	}
	if (entry.type === "branch_summary") {
		return { label: "branch-summary", text: entry.summary };
	}
	return { label: entry.type, text: JSON.stringify(entry) };
}

function topItems(items: BreakdownItem[], limit: number): BreakdownItem[] {
	return [...items].sort((a, b) => b.tokens - a.tokens).slice(0, limit);
}

function buildReport(ctx: ExtensionCommandContext, pi: ExtensionAPI, snapshot: Snapshot | undefined): string {
	const usage = ctx.getContextUsage();
	const usageTokens = usage?.tokens ?? null;
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? null;
	const percent = usage?.percent == null ? "?" : `${usage.percent.toFixed(1)}%`;
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown model";

	const branch = ctx.sessionManager.getBranch();
	const contextEntries = branch.filter((entry) =>
		["message", "custom_message", "compaction", "branch_summary"].includes(entry.type),
	);
	const conversationItems = contextEntries.map((entry) => {
		const summary = entrySummary(entry);
		const skillBlock = summary.label === "message:user" ? parseSkillBlock(summary.text) : null;
		return {
			label: skillBlock ? "skill-invocation" : summary.label,
			tokens: estimateTokens(summary.text),
			detail: skillBlock ? `${skillBlock.name}${skillBlock.userMessage ? ` — ${truncate(skillBlock.userMessage, 60)}` : ""}` : truncate(summary.text, 86),
		};
	});

	const skillInvocationTokens = conversationItems
		.filter((item) => item.label === "skill-invocation")
		.reduce((sum, item) => sum + item.tokens, 0);
	const userTokens = conversationItems
		.filter((item) => item.label === "message:user")
		.reduce((sum, item) => sum + item.tokens, 0);
	const assistantTokens = conversationItems
		.filter((item) => item.label === "message:assistant")
		.reduce((sum, item) => sum + item.tokens, 0);
	const toolResultTokens = conversationItems
		.filter((item) => item.label === "message:toolResult")
		.reduce((sum, item) => sum + item.tokens, 0);
	const oldContextReportTokens = conversationItems
		.filter((item) => item.label === `custom:${CUSTOM_TYPE}`)
		.reduce((sum, item) => sum + item.tokens, 0);
	const customAndSummaryTokens = conversationItems
		.filter((item) => !["message:user", "message:assistant", "message:toolResult", "skill-invocation", `custom:${CUSTOM_TYPE}`].includes(item.label))
		.reduce((sum, item) => sum + item.tokens, 0);
	const conversationTokens = userTokens + assistantTokens + toolResultTokens + skillInvocationTokens + oldContextReportTokens + customAndSummaryTokens;

	const systemPrompt = snapshot?.systemPrompt ?? ctx.getSystemPrompt();
	const systemTokens = estimateTokens(systemPrompt);
	const options = snapshot?.options;

	const resourceItems: BreakdownItem[] = [];
	if (options?.contextFiles) {
		for (const file of options.contextFiles) {
			resourceItems.push({ label: file.path, tokens: estimateTokens(file.content) });
		}
	}
	const loadedOtherTokens = resourceItems.reduce((sum, item) => sum + item.tokens, 0);

	const commands = pi.getCommands();
	const prompts = commands.filter((cmd) => cmd.source === "prompt");
	const skillCommands = commands.filter((cmd) => cmd.source === "skill");
	const extensionCommands = commands.filter((cmd) => cmd.source === "extension");

	const skills = options?.skills ?? [];
	const skillItems = snapshot
		? skills.map((skill) => ({
				label: skill.name,
				tokens: estimateTokens(`<skill><name>${skill.name}</name><description>${skill.description}</description><location>${skill.filePath}</location></skill>`),
				detail: `${truncate(skill.description, 70)} — ${skill.filePath}`,
			}))
		: skillCommands.map((cmd) => ({
				label: cmd.name.replace(/^skill:/, ""),
				tokens: estimateTokens(`<skill><name>${cmd.name}</name><description>${cmd.description ?? ""}</description><location>${cmd.sourceInfo.path}</location></skill>`),
				detail: `${truncate(cmd.description ?? "", 70)} — ${cmd.sourceInfo.path}`,
			}));
	const skillDefinitionTokens = snapshot ? estimateTokens(formatSkillsForPrompt(skills)) : skillItems.reduce((sum, item) => sum + item.tokens, 0);

	const activeTools = pi.getActiveTools();
	const allTools = pi.getAllTools();
	const toolSnippetTokens = estimateTokens(options?.toolSnippets ?? {});
	const guidelineTokens = estimateTokens(options?.promptGuidelines ?? []);
	const estimatedToolPromptTokens = snapshot ? toolSnippetTokens + guidelineTokens : activeTools.length * 20;
	const toolTokens = toolResultTokens + estimatedToolPromptTokens;
	const otherLoadedTokens = loadedOtherTokens + customAndSummaryTokens;
	const systemOnlyTokens = Math.max(0, systemTokens - skillDefinitionTokens - loadedOtherTokens - estimatedToolPromptTokens);

	const rows = [
		["System prompt", systemOnlyTokens, snapshot ? "base/custom prompt, excluding skills/tools/files" : "base prompt estimate"],
		["Skill definitions", skillDefinitionTokens, `${skillItems.length} skill descriptions in system prompt`],
		["Skill invocations", skillInvocationTokens, "full SKILL.md blocks loaded by /skill or model use"],
		["Other loaded", otherLoadedTokens, `${resourceItems.length} context files + custom/summary messages`],
		["Old /context reports", oldContextReportTokens, "from earlier saved reports; new /context output is temporary"],
		["Your messages", userTokens, "normal user messages, excluding skill blocks"],
		["Assistant messages", assistantTokens, "assistant text/thinking"],
		["Tools + results", toolTokens, `${toolResultTokens.toLocaleString()} result tks + ~${estimatedToolPromptTokens} prompt tks`],
	] as const;

	const lines: string[] = [];
	lines.push(`Model   ${model}`);
	lines.push(`Context ${fmt(usageTokens)} / ${fmt(contextWindow)} tokens (${percent} of window)`);
	lines.push("");
	lines.push("Context mix (estimated)");
	lines.push(
		...table(
			["Area", "Tokens", "% used", "% window", "", "Notes"],
			rows.map(([label, tokens, note]) => [
				label,
				`~${fmt(tokens)}`,
				pct(tokens, usageTokens),
				pct(tokens, contextWindow),
				bar(tokens, usageTokens),
				note,
			]),
		),
	);
	lines.push("");
	lines.push("Quick read");
	lines.push(`- Biggest bucket: ${[...rows].sort((a, b) => b[1] - a[1])[0][0]}`);
	lines.push(`- Conversation estimate: ~${fmt(conversationTokens)} tokens across ${contextEntries.length} entries`);
	lines.push(`- System prompt total: ~${fmt(systemTokens)} tokens (${systemPrompt.length.toLocaleString()} chars)`);
	if (snapshot) lines.push(`- Resource snapshot: ${new Date(snapshot.capturedAt).toLocaleString()}`);
	else lines.push("- Skill definition estimates use slash-command metadata until before_agent_start captures exact prompt resources.");
	lines.push("");

	lines.push("Largest context entries");
	lines.push(
		...table(
			["Tokens", "Type", "Preview"],
			topItems(conversationItems, 10).map((item) => [`~${fmt(item.tokens)}`, item.label.replace("message:", ""), item.detail ?? ""]),
		),
	);
	lines.push("");

	lines.push("Loaded/available stuff");
	lines.push(
		...table(
			["Thing", "Count", "In context?", "Examples"],
			[
				["Active tools", `${activeTools.length}/${allTools.length}`, "yes (tools/results dominate after use)", activeTools.join(", ") || "none"],
				["Context files", `${resourceItems.length}`, snapshot ? "yes" : "unknown", resourceItems.slice(0, 3).map((i) => i.label).join(", ") || "none"],
				["Skill definitions", `${skillItems.length}`, "yes, descriptions", skillItems.slice(0, 5).map((i) => i.label).join(", ") || "none"],
				["Prompt templates", `${prompts.length}`, "no, until invoked", prompts.slice(0, 5).map((c) => `/${c.name}`).join(", ") || "none"],
				["Skill commands", `${skillCommands.length}`, "no, until invoked", skillCommands.slice(0, 5).map((c) => `/${c.name}`).join(", ") || "none"],
				["Extension cmds", `${extensionCommands.length}`, "no", extensionCommands.slice(0, 5).map((c) => `/${c.name}`).join(", ") || "none"],
			],
		),
	);
	lines.push("");
	lines.push("Note: bucket numbers are rough char/4 estimates; the top Context line is pi/provider usage.");

	return lines.join("\n");
}

export default function contextExtension(pi: ExtensionAPI) {
	let lastSnapshot: Snapshot | undefined;

	pi.on("before_agent_start", (event) => {
		lastSnapshot = {
			systemPrompt: event.systemPrompt,
			options: event.systemPromptOptions,
			capturedAt: Date.now(),
		};
	});

	pi.registerCommand("context", {
		description: "Show what's taking up context: system prompt, context files, skills, tools, prompts, and session messages",
		handler: async (_args, ctx) => {
			const report = buildReport(ctx, pi, lastSnapshot);

			if (!ctx.hasUI) {
				ctx.ui.notify(report, "info");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				return new ContextReportPanel(report, tui, theme, () => done());
			});
		},
	});
}
