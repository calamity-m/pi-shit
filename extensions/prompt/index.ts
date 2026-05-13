import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type EditorComponent, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

type PromptTemplate = {
	name: string;
	description: string;
	argumentHint: string;
	path: string;
	body: string;
};

function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
	if (!text.startsWith("---\n")) return { data: {}, body: text };

	const end = text.indexOf("\n---", 4);
	if (end === -1) return { data: {}, body: text };

	const data: Record<string, string> = {};
	const frontmatter = text.slice(4, end);
	for (const line of frontmatter.split("\n")) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) continue;
		data[match[1]] = match[2].replace(/^['\"]|['\"]$/g, "");
	}

	const bodyStart = text.startsWith("\n", end + 4) ? end + 5 : end + 4;
	return { data, body: text.slice(bodyStart) };
}

function readPrompt(command: SlashCommandInfo): PromptTemplate | undefined {
	try {
		const text = readFileSync(command.sourceInfo.path, "utf8");
		const parsed = parseFrontmatter(text);
		return {
			name: command.name,
			description: command.description ?? parsed.data.description ?? "",
			argumentHint: parsed.data["argument-hint"] ?? "",
			path: command.sourceInfo.path,
			body: parsed.body.trim(),
		};
	} catch {
		return undefined;
	}
}

function splitArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (const char of input) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	if (escaped) current += "\\";
	if (current) args.push(current);
	return args;
}

function expandPrompt(body: string, rawArgs: string): string {
	const positional = splitArgs(rawArgs);
	return body
		.replace(/\$ARGUMENTS/g, rawArgs)
		.replace(/\$@/g, rawArgs)
		.replace(/\$\{@:([0-9]+)(?::([0-9]+))?\}/g, (_match, startText: string, lengthText: string | undefined) => {
			const start = Math.max(0, Number(startText) - 1);
			const length = lengthText === undefined ? undefined : Math.max(0, Number(lengthText));
			return positional.slice(start, length === undefined ? undefined : start + length).join(" ");
		})
		.replace(/\$([1-9][0-9]*)/g, (_match, indexText: string) => positional[Number(indexText) - 1] ?? "");
}

function promptLabel(prompt: PromptTemplate): string {
	const hint = prompt.argumentHint ? ` ${prompt.argumentHint}` : "";
	const description = prompt.description ? ` — ${prompt.description}` : "";
	return `/${prompt.name}${hint}${description}`;
}

type FillField = {
	tokens: string[];
	label: string;
	value: string;
};

function detectFillFields(body: string, initialArgs: string): FillField[] {
	const fields = new Map<string, FillField>();
	const positional = splitArgs(initialArgs);
	const hasRawArguments = /\$(?:ARGUMENTS|@)(?![A-Za-z0-9_])/.test(body);

	if (hasRawArguments) {
		const rawField = { tokens: ["$ARGUMENTS", "$@"], label: "$ARGUMENTS", value: initialArgs };
		fields.set("$ARGUMENTS", rawField);
		fields.set("$@", rawField);
	}

	for (const match of body.matchAll(/\$([1-9][0-9]*)/g)) {
		const token = match[0];
		const index = Number(match[1]);
		if (!fields.has(token)) fields.set(token, { tokens: [token], label: token, value: positional[index - 1] ?? "" });
	}

	for (const match of body.matchAll(/\$\{@:([0-9]+)(?::([0-9]+))?\}/g)) {
		const token = match[0];
		const start = Math.max(0, Number(match[1]) - 1);
		const length = match[2] === undefined ? undefined : Math.max(0, Number(match[2]));
		if (!fields.has(token)) fields.set(token, { tokens: [token], label: token, value: positional.slice(start, length === undefined ? undefined : start + length).join(" ") });
	}

	return [...new Set(fields.values())];
}

function expandVisualPrompt(body: string, fields: FillField[]): string {
	let text = body;
	const replacements = fields.flatMap((field) => field.tokens.map((token) => ({ token, value: field.value })));
	for (const replacement of replacements.sort((a, b) => b.token.length - a.token.length)) {
		text = text.replaceAll(replacement.token, replacement.value);
	}
	return text;
}

const FILL_CONTEXT_LINES_BEFORE = 5;
const FILL_CONTEXT_LINES_AFTER = 8;

class PromptFillEditor implements EditorComponent, Focusable {
	focused = false;
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	private active = 0;

	constructor(
		private readonly tui: TUI,
		private readonly prompt: PromptTemplate,
		private readonly body: string,
		private readonly fields: FillField[],
		private readonly theme: ExtensionCommandContext["ui"]["theme"],
		private readonly done: (result: string | undefined) => void,
	) {}

	getText(): string {
		return expandVisualPrompt(this.body, this.fields);
	}

	setText(_text: string): void {}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.active = Math.max(0, this.active - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.enter)) {
			this.advance();
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			const field = this.fields[this.active];
			field.value = [...field.value].slice(0, -1).join("");
			this.onChange?.(this.getText());
			this.tui.requestRender();
			return;
		}

		const paste = data.match(/^\x1b\[200~([\s\S]*)\x1b\[201~$/)?.[1];
		if (paste !== undefined) {
			this.fields[this.active].value += paste;
			this.onChange?.(this.getText());
			this.tui.requestRender();
			return;
		}

		if (data.length > 0 && !data.startsWith("\x1b")) {
			this.fields[this.active].value += data;
			this.onChange?.(this.getText());
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const pane = this.renderBodyPane();
		const border = this.theme.fg("border", "─".repeat(Math.max(0, width)));
		const lines = [
			border,
			truncateToWidth(this.theme.fg("accent", `Filling /${this.prompt.name} (${this.active + 1}/${this.fields.length}): ${this.fields[this.active].label}`), width),
			truncateToWidth(this.theme.fg("dim", "Type to fill highlighted variable • tab/enter next • shift+tab previous • esc cancel"), width),
			"",
		];
		if (pane.start > 0) lines.push(truncateToWidth(this.theme.fg("dim", `… ${pane.start} lines above hidden`), width));
		for (const line of pane.lines) lines.push(...wrapTextWithAnsi(line, width));
		if (pane.end < pane.total) lines.push(truncateToWidth(this.theme.fg("dim", `… ${pane.total - pane.end} lines below hidden`), width));
		lines.push(border);
		return lines;
	}

	private advance(): void {
		if (this.active < this.fields.length - 1) {
			this.active++;
			this.tui.requestRender();
			return;
		}
		const finalText = this.getText();
		this.onSubmit?.(finalText);
		this.done(finalText);
	}

	private renderBodyPane(): { lines: string[]; start: number; end: number; total: number } {
		const sourceLines = this.body.split("\n");
		const activeField = this.fields[this.active];
		const activeLine = Math.max(0, sourceLines.findIndex((line) => activeField.tokens.some((token) => line.includes(token))));
		const start = Math.max(0, activeLine - FILL_CONTEXT_LINES_BEFORE);
		const end = Math.min(sourceLines.length, activeLine + FILL_CONTEXT_LINES_AFTER + 1);
		return {
			lines: sourceLines.slice(start, end).map((line) => this.renderBodyLine(line)),
			start,
			end,
			total: sourceLines.length,
		};
	}

	private renderBodyLine(line: string): string {
		const fieldsByToken = new Map(this.fields.flatMap((field) => field.tokens.map((token) => [token, field] as const)));
		const activeField = this.fields[this.active];
		let rendered = "";
		let index = 0;

		for (const match of line.matchAll(/\$ARGUMENTS|\$@|\$[1-9][0-9]*|\$\{@:[0-9]+(?::[0-9]+)?\}/g)) {
			const token = match[0];
			const start = match.index ?? 0;
			rendered += this.theme.fg("dim", line.slice(index, start));

			const field = fieldsByToken.get(token);
			if (!field) {
				rendered += this.theme.fg("dim", token);
			} else if (field !== activeField) {
				rendered += this.theme.fg("muted", field.value || `⟦${field.label}⟧`);
			} else {
				const text = field.value || `⟦${field.label}⟧`;
				rendered += this.theme.bg("selectedBg", this.theme.fg("accent", `${text}${this.focused ? CURSOR_MARKER : ""} `));
			}

			index = start + token.length;
		}

		rendered += this.theme.fg("dim", line.slice(index));
		return rendered;
	}
}

async function fillPromptVisually(ctx: ExtensionCommandContext, prompt: PromptTemplate, initialArgs: string): Promise<string | undefined> {
	const fields = detectFillFields(prompt.body, initialArgs);
	if (fields.length === 0) return prompt.body;

	if (!process.stdout.isTTY) {
		const label = prompt.argumentHint ? `Arguments for /${prompt.name}: ${prompt.argumentHint}` : `Arguments for /${prompt.name}`;
		const multilineArgs = await ctx.ui.editor(label, initialArgs);
		return multilineArgs === undefined ? undefined : expandPrompt(prompt.body, multilineArgs.trim());
	}

	const previousEditor = ctx.ui.getEditorComponent();
	try {
		return await new Promise<string | undefined>((resolve) => {
			ctx.ui.setEditorComponent((tui) => new PromptFillEditor(tui, prompt, prompt.body, fields, ctx.ui.theme, resolve));
		});
	} finally {
		ctx.ui.setEditorComponent(previousEditor);
	}
}

export default function promptExtension(pi: ExtensionAPI) {
	pi.registerCommand("prompt", {
		description: "Pick a prompt template, visually fill variables, and populate the editor",
		getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
			const prompts = pi.getCommands().filter((command) => command.source === "prompt");
			const items = prompts
				.filter((command) => command.name.startsWith(prefix))
				.map((command) => ({ value: command.name, label: command.name, description: command.description }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const prompts = pi.getCommands().filter((command) => command.source === "prompt").map(readPrompt).filter((prompt): prompt is PromptTemplate => prompt !== undefined);
			if (prompts.length === 0) {
				ctx.ui.notify("No prompt templates available", "info");
				return;
			}

			const [requestedName, ...rest] = splitArgs(args);
			let prompt = requestedName ? prompts.find((item) => item.name === requestedName || `/${item.name}` === requestedName) : undefined;
			if (!prompt) {
				const selected = await ctx.ui.select("Pick a prompt template", prompts.map(promptLabel));
				if (!selected) return;
				const selectedName = selected.match(/^\/([^\s]+)/)?.[1];
				prompt = prompts.find((item) => item.name === selectedName);
				if (!prompt) return;
			}

			const initialArgs = prompt.name === requestedName || `/${prompt.name}` === requestedName ? rest.join(" ") : args;
			const filled = await fillPromptVisually(ctx, prompt, initialArgs.trim());
			if (filled === undefined) return;

			ctx.ui.setEditorText(filled);
			ctx.ui.notify(`Filled editor from /${prompt.name}`, "info");
		},
	});
}
