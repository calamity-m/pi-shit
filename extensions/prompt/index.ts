import { readFileSync } from "node:fs";
import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
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
	const detail = prompt.argumentHint || prompt.description;
	return detail ? `/${prompt.name} ${detail}` : `/${prompt.name}`;
}

export default function promptExtension(pi: ExtensionAPI) {
	pi.registerCommand("prompt", {
		description: "Pick a prompt template, collect multiline arguments, and fill the editor",
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
			const label = prompt.argumentHint ? `Arguments for /${prompt.name}: ${prompt.argumentHint}` : `Arguments for /${prompt.name}`;
			const multilineArgs = await ctx.ui.editor(label, initialArgs);
			if (multilineArgs === undefined) return;

			ctx.ui.setEditorText(expandPrompt(prompt.body, multilineArgs.trim()));
			ctx.ui.notify(`Filled editor from /${prompt.name}`, "info");
		},
	});
}
