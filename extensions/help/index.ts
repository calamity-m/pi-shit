import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Focusable, type Keybinding, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";

type HelpItem = {
	action?: Keybinding;
	fallback?: string | string[];
	keys?: string | string[];
	description: string;
};

const HELP_ITEMS: HelpItem[] = [
	{ action: "app.interrupt", fallback: "escape", description: "interrupt / cancel" },
	{ action: "app.clear", fallback: "ctrl+c", description: "clear editor" },
	{ fallback: "ctrl+c twice", description: "exit" },
	{ action: "app.exit", fallback: "ctrl+d", description: "exit when editor is empty" },
	{ action: "app.suspend", fallback: "ctrl+z", description: "suspend to background" },
	{ action: "tui.editor.deleteToLineEnd", fallback: "ctrl+k", description: "delete to end of line" },
	{ action: "app.thinking.cycle", fallback: "shift+tab", description: "cycle thinking level" },
	{ action: "app.model.cycleForward", fallback: "ctrl+p", description: "cycle to next model" },
	{ action: "app.model.cycleBackward", fallback: "shift+ctrl+p", description: "cycle to previous model" },
	{ action: "app.model.select", fallback: "ctrl+l", description: "select model" },
	{ action: "app.tools.expand", fallback: "ctrl+o", description: "collapse / expand tool output" },
	{ action: "app.thinking.toggle", fallback: "ctrl+t", description: "collapse / expand thinking" },
	{ action: "app.editor.external", fallback: "ctrl+g", description: "open external editor" },
	{ keys: "/", description: "open slash commands" },
	{ keys: "!", description: "run bash and include output in context" },
	{ keys: "!!", description: "run bash without adding output to context" },
	{ action: "app.message.followUp", fallback: "alt+enter", description: "queue follow-up message" },
	{ action: "app.message.dequeue", fallback: "alt+up", description: "edit all queued messages" },
	{ action: "app.clipboard.pasteImage", fallback: "ctrl+v", description: "paste image from clipboard" },
	{ keys: "drop files", description: "attach files" },
];

class HelpPanel implements Focusable {
	focused = false;
	private scroll = 0;
	private readonly rows: string[];

	constructor(
		private keybindings: KeybindingsManager,
		private tui: TUI,
		private theme: any,
		private done: () => void,
	) {
		this.rows = buildHelpRows(keybindings);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "app.interrupt") || matchesKey(data, "return") || data === "q") {
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
		const visibleRows = 24;
		const maxScroll = this.maxScroll(visibleRows);
		this.scroll = Math.min(this.scroll, maxScroll);
		const visible = this.rows.slice(this.scroll, this.scroll + visibleRows);
		const th = this.theme;
		const border = (text: string) => th.fg("border", text);
		const pad = (text: string) => {
			const truncated = truncateToWidth(text, innerWidth, "");
			return truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
		};
		const footer = ` Enter/Esc/q close · ↑/↓ scroll · Ctrl+u/d page · ${this.scroll + 1}-${Math.min(this.scroll + visibleRows, this.rows.length)}/${this.rows.length} `;

		return [
			border(`╭${"─".repeat(innerWidth)}╮`),
			`${border("│")}${pad(` ${th.fg("accent", th.bold("Pi help"))} ${th.fg("dim", "(effective keybindings from settings)")}`)}${border("│")}`,
			`${border("│")}${pad("")}${border("│")}`,
			...visible.map((line) => `${border("│")}${pad(line)}${border("│")}`),
			...Array.from({ length: Math.max(0, visibleRows - visible.length) }, () => `${border("│")}${pad("")}${border("│")}`),
			border(`├${"─".repeat(innerWidth)}┤`),
			`${border("│")}${pad(th.fg("dim", footer))}${border("│")}`,
			border(`╰${"─".repeat(innerWidth)}╯`),
		];
	}

	invalidate(): void {}

	private maxScroll(visibleRows = 24): number {
		return Math.max(0, this.rows.length - visibleRows);
	}
}

function buildHelpRows(keybindings: KeybindingsManager): string[] {
	const rows = HELP_ITEMS.map((item) => [keysFor(item, keybindings), item.description] as const);
	const keyWidth = Math.max(...rows.map(([keys]) => visibleWidth(keys)));
	return rows.map(([keys, description]) => ` ${keys.padEnd(keyWidth)}  ${description}`);
}

function keysFor(item: HelpItem, keybindings: KeybindingsManager): string {
	if (item.keys) return formatKeys(item.keys);
	if (!item.action) return "";

	const configured = keybindings.getKeys(item.action);
	return formatKeys(configured.length > 0 ? configured : item.fallback ?? []);
}

function formatKeys(keys: string | readonly string[]): string {
	const list = Array.isArray(keys) ? keys : [keys];
	return list.map(formatKey).join(" / ");
}

function formatKey(key: string): string {
	if (key === "!") return "!";
	if (key === "!!") return "!!";
	if (key === "/") return "/";
	return key
		.split("+")
		.map((part) => {
			if (part.length === 1) return part.toUpperCase();
			if (part === "ctrl") return "Ctrl";
			if (part === "alt") return "Alt";
			if (part === "shift") return "Shift";
			if (part === "escape") return "Esc";
			if (part === "return") return "Enter";
			return part[0].toUpperCase() + part.slice(1);
		})
		.join("+");
}

export default function helpExtension(pi: ExtensionAPI) {
	pi.registerCommand("help", {
		description: "Show a quick Pi keybinding and command reference",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(buildFallbackHelp(), "info");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
				return new HelpPanel(keybindings, tui, theme, () => done());
			});
		},
	});
}

function buildFallbackHelp(): string {
	return HELP_ITEMS.map((item) => `${formatKeys(item.keys ?? item.fallback ?? [])} - ${item.description}`).join("\n");
}
