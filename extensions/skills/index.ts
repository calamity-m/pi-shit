import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { isToolCallEventType, type ExtensionAPI, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Focusable, type TUI } from "@earendil-works/pi-tui";

type SortMode = "scope" | "name" | "tokens";

type SkillRow = {
	name: string;
	description: string;
	path: string;
	scope: string;
	status: "on" | "user-only";
	tokens: number;
};

type SkillStats = {
	userUsed: number;
	agentLoaded: number;
	lastUser?: string;
	lastAgent?: string;
	paths: string[];
};

type StatsFile = {
	version: 1;
	skills: Record<string, SkillStats>;
};

type SkillIndexEntry = {
	name: string;
	path: string;
};

type SkillIndex = {
	byName: Map<string, SkillIndexEntry>;
	byPath: Map<string, SkillIndexEntry>;
};

const STATS_PATH = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "pi-shit", "skill-stats.json");

function estimateTokens(value: string): number {
	return Math.max(1, Math.ceil(value.length / 4));
}

function readStatus(path: string): "on" | "user-only" {
	try {
		const text = readFileSync(path, "utf8");
		const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
		return frontmatter?.[1]?.match(/^disable-model-invocation:\s*true\s*$/m) ? "user-only" : "on";
	} catch {
		return "on";
	}
}

function normalizePath(path: string, cwd: string): string {
	return normalize(path.startsWith("/") ? path : resolve(cwd, path));
}

function readStats(): StatsFile {
	try {
		const parsed = JSON.parse(readFileSync(STATS_PATH, "utf8")) as StatsFile;
		return parsed.version === 1 && parsed.skills ? parsed : { version: 1, skills: {} };
	} catch {
		return { version: 1, skills: {} };
	}
}

function writeStats(stats: StatsFile): void {
	mkdirSync(dirname(STATS_PATH), { recursive: true });
	writeFileSync(STATS_PATH, `${JSON.stringify(stats, null, "\t")}\n`);
}

function recordSkill(name: string, path: string | undefined, kind: "user" | "agent"): void {
	const stats = readStats();
	const entry = stats.skills[name] ??= { userUsed: 0, agentLoaded: 0, paths: [] };
	if (path && !entry.paths.includes(path)) entry.paths.push(path);

	const now = new Date().toISOString();
	if (kind === "user") {
		entry.userUsed++;
		entry.lastUser = now;
	} else {
		entry.agentLoaded++;
		entry.lastAgent = now;
	}

	writeStats(stats);
}

function buildSkillIndex(pi: ExtensionAPI, cwd: string): SkillIndex {
	const byName = new Map<string, SkillIndexEntry>();
	const byPath = new Map<string, SkillIndexEntry>();

	for (const command of pi.getCommands().filter((command) => command.source === "skill")) {
		const name = command.name.replace(/^skill:/, "");
		const path = normalizePath(command.sourceInfo.path, cwd);
		const entry = { name, path };
		byName.set(name, entry);
		byPath.set(path, entry);
	}

	return { byName, byPath };
}

function scopeLabel(command: SlashCommandInfo): string {
	const info = command.sourceInfo;
	if (info.scope === "project") return "project";
	if (info.scope === "temporary") return "temporary";
	if (info.origin === "package") return "installed";
	return "user";
}

function toSkillRow(command: SlashCommandInfo): SkillRow {
	const name = command.name.replace(/^skill:/, "");
	const description = command.description ?? "";
	const path = command.sourceInfo.path;
	return {
		name,
		description,
		path,
		scope: scopeLabel(command),
		status: readStatus(path),
		tokens: estimateTokens(`<skill><name>${name}</name><description>${description}</description><location>${path}</location></skill>`),
	};
}

function pad(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

class SkillsPanel implements Focusable {
	focused = false;
	private selected = 0;
	private scroll = 0;
	private query = "";
	private searchActive = false;
	private sort: SortMode = "scope";

	constructor(
		private skills: SkillRow[],
		private tui: TUI,
		private theme: any,
		private done: () => void,
	) {}

	handleInput(data: string): void {
		if (this.searchActive) {
			if (matchesKey(data, "escape") || matchesKey(data, "return")) {
				this.searchActive = false;
			} else if (matchesKey(data, "backspace")) {
				this.query = this.query.slice(0, -1);
				this.selected = 0;
				this.scroll = 0;
			} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.query += data;
				this.selected = 0;
				this.scroll = 0;
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "escape") || data === "q") {
			this.done();
			return;
		}
		if (data === "/") this.searchActive = true;
		else if (data === "t") this.cycleSort();
		else if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else if (matchesKey(data, "ctrl+u")) this.move(-10);
		else if (matchesKey(data, "ctrl+d")) this.move(10);
		else if (matchesKey(data, "home")) this.selected = 0;
		else if (matchesKey(data, "end")) this.selected = Math.max(0, this.filtered().length - 1);
		else if (matchesKey(data, "return")) this.done();
		else return;

		this.keepSelectionVisible();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const rows = this.filtered();
		const selectedSkill = rows[this.selected];
		const groups = this.groupRows(rows);
		const header = ` Skills`;
		const help = ` ${this.skills.length} skills · / search · t sort (${this.sort}) · ↑/↓ move · Enter/Esc/q close`;
		const searchText = this.query || "Search skills…";
		const border = (text: string) => th.fg("border", text);
		const innerWidth = Math.max(20, width - 4);
		const searchLine = `${border("╭")}${border("─".repeat(innerWidth))}${border("╮")}`;
		const searchBody = `${border("│")}${pad(` ${this.searchActive ? "⌕" : " "} ${this.query ? searchText : th.fg("dim", searchText)}`, innerWidth)}${border("│")}`;
		const listHeight = 22;
		const visibleList = groups.slice(this.scroll, this.scroll + listHeight);
		const lines = [
			th.fg("accent", th.bold(header)),
			th.fg("dim", help),
			"",
			` ${searchLine}`,
			` ${searchBody}`,
			` ${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`,
			"",
		];

		for (const item of visibleList) {
			if (item.type === "group") {
				lines.push(th.fg("muted", ` ${item.label}`));
				continue;
			}
			const skill = item.skill;
			const index = rows.indexOf(skill);
			const marker = index === this.selected ? th.fg("accent", "❯") : " ";
			const status = skill.status === "on" ? th.fg("success", "on") : th.fg("warning", "user-only");
			const row = `${marker} ${pad(status, 12)} ${pad(skill.name, 26)} ${pad(skill.scope, 10)} ${pad(`~${skill.tokens} tks`, 9)} ${th.fg("dim", skill.description)}`;
			lines.push(truncateToWidth(row, width, ""));
		}

		lines.push("");
		if (selectedSkill) {
			lines.push(th.fg("accent", ` ${selectedSkill.name}`));
			lines.push(truncateToWidth(` ${selectedSkill.description || "No description"}`, width, ""));
			lines.push(th.fg("dim", truncateToWidth(` ${selectedSkill.path}`, width, "")));
		} else {
			lines.push(th.fg("dim", " No matching skills"));
		}

		return lines;
	}

	invalidate(): void {}

	private filtered(): SkillRow[] {
		const query = this.query.trim().toLowerCase();
		const rows = query
			? this.skills.filter((skill) => `${skill.name} ${skill.description} ${skill.scope}`.toLowerCase().includes(query))
			: [...this.skills];

		return rows.sort((a, b) => {
			if (this.sort === "name") return a.name.localeCompare(b.name);
			if (this.sort === "tokens") return b.tokens - a.tokens || a.name.localeCompare(b.name);
			return a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name);
		});
	}

	private groupRows(rows: SkillRow[]): Array<{ type: "group"; label: string } | { type: "skill"; skill: SkillRow }> {
		const result: Array<{ type: "group"; label: string } | { type: "skill"; skill: SkillRow }> = [];
		let lastScope = "";
		for (const skill of rows) {
			if (this.sort === "scope" && skill.scope !== lastScope) {
				if (result.length > 0) result.push({ type: "group", label: "" });
				lastScope = skill.scope;
				result.push({ type: "group", label: `${skill.scope.toUpperCase()} SKILLS` });
			}
			result.push({ type: "skill", skill });
		}
		return result;
	}

	private move(delta: number): void {
		this.selected = Math.max(0, Math.min(this.filtered().length - 1, this.selected + delta));
	}

	private cycleSort(): void {
		this.sort = this.sort === "scope" ? "name" : this.sort === "name" ? "tokens" : "scope";
		this.selected = 0;
		this.scroll = 0;
	}

	private keepSelectionVisible(): void {
		const rows = this.filtered();
		this.selected = Math.max(0, Math.min(rows.length - 1, this.selected));
		const grouped = this.groupRows(rows);
		const selectedRow = rows[this.selected];
		const groupedIndex = grouped.findIndex((item) => item.type === "skill" && item.skill === selectedRow);
		if (groupedIndex < this.scroll) this.scroll = groupedIndex;
		else if (groupedIndex >= this.scroll + 22) this.scroll = groupedIndex - 21;
		this.scroll = Math.max(0, this.scroll);
	}
}

export default function skillsExtension(pi: ExtensionAPI) {
	pi.on("input", (event, ctx) => {
		const match = event.text.match(/^\/skill:([^\s]+)(?:\s|$)/);
		if (!match) return;

		const skill = buildSkillIndex(pi, ctx.cwd).byName.get(match[1]);
		if (!skill) return;

		recordSkill(skill.name, skill.path, "user");
	});

	pi.on("tool_call", (event, ctx) => {
		if (!isToolCallEventType("read", event)) return;

		const path = normalizePath(event.input.path, ctx.cwd);
		const skill = buildSkillIndex(pi, ctx.cwd).byPath.get(path);
		if (!skill) return;

		recordSkill(skill.name, skill.path, "agent");
	});

	pi.registerCommand("skills", {
		description: "Browse available skills by source",
		handler: async (_args, ctx) => {
			const skills = pi.getCommands().filter((command) => command.source === "skill").map(toSkillRow);
			if (skills.length === 0) {
				ctx.ui.notify("No skills available", "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(skills.map((skill) => `${skill.name} (${skill.scope}, ${skill.status})`).join("\n"), "info");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				return new SkillsPanel(skills, tui, theme, () => done());
			});
		},
	});
}
