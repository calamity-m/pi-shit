import { SessionManager, VERSION, type ExtensionAPI, type ExtensionContext, type SessionInfo, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const AUTO_CLOSE_SECONDS = 15;

type DashboardData = {
	model: string;
	provider: string;
	cwd: string;
	loaded: Array<[string, number]>;
	recentSessions: Array<{ label: string; age: string }>;
};

class DashboardOverlay {
	private closed = false;
	private readonly startedAt = Date.now();
	private readonly interval: ReturnType<typeof setInterval>;

	constructor(
		private data: DashboardData,
		private theme: Theme,
		private requestRender: () => void,
		private done: () => void,
	) {
		this.interval = setInterval(() => {
			if (this.remainingSeconds() <= 0) this.close();
			else this.requestRender();
		}, 1000);
	}

	handleInput(): void {
		this.close();
	}

	render(width: number): string[] {
		const panelWidth = Math.max(58, Math.min(width, 78));
		const innerWidth = panelWidth - 2;
		const leftWidth = 26;
		const rightWidth = innerWidth - leftWidth - 1;
		const th = this.theme;
		const border = (text: string) => th.fg("border", text);
		const pad = (text: string, cellWidth: number) => {
			const truncated = truncateToWidth(text, cellWidth, "");
			return truncated + " ".repeat(Math.max(0, cellWidth - visibleWidth(truncated)));
		};
		const row = (left: string, right = "") =>
			`${border("│")}${pad(left, leftWidth)}${border("│")}${pad(right, rightWidth)}${border("│")}`;
		const full = (text = "") => `${border("│")}${pad(text, innerWidth)}${border("│")}`;
		const rule = `${border("├")}${border("─".repeat(leftWidth))}${border("┼")}${border("─".repeat(rightWidth))}${border("┤")}`;
		const title = ` ${th.fg("accent", th.bold("pi-shit"))} ${th.fg("dim", `v${VERSION}`)} `;
		const footer = ` Press any key to continue (${this.remainingSeconds()}s) `;
		const left = buildLeftColumn(this.data, th);
		const right = buildRightColumn(this.data, th);
		const rows = Math.max(left.length, right.length);

		return [
			`${border("╭")}${border("─".repeat(3))}${title}${border("─".repeat(Math.max(0, innerWidth - visibleWidth(title) - 3)))}${border("╮")}`,
			...Array.from({ length: rows }, (_, i) => row(left[i] ?? "", right[i] ?? "")),
			rule,
			full(th.fg("dim", footer)),
			border(`╰${"─".repeat(innerWidth)}╯`),
		];
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.interval);
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.dispose();
		this.done();
	}

	private remainingSeconds(): number {
		return Math.max(0, AUTO_CLOSE_SECONDS - Math.floor((Date.now() - this.startedAt) / 1000));
	}
}

function buildLeftColumn(data: DashboardData, theme: Theme): string[] {
	const accent = (text: string) => theme.fg("accent", text);
	const cyan = (text: string) => theme.fg("success", text);
	const muted = (text: string) => theme.fg("muted", text);
	const dim = (text: string) => theme.fg("dim", text);

	return [
		"",
		` ${theme.bold("Welcome back!")}`,
		"",
		`     ${accent("████")}${cyan("██")}`,
		`      ${accent("██")}  ${cyan("██")}`,
		`      ${accent("██")}  ${cyan("██")}`,
		`      ${accent("██")}  ${cyan("██")}`,
		`     ${accent("████")}${cyan("██")}`,
		"",
		` ${accent(data.model)}`,
		` ${dim(data.provider)}`,
		"",
		` ${muted("cwd")}`,
		` ${dim(data.cwd)}`,
	];
}

function buildRightColumn(data: DashboardData, theme: Theme): string[] {
	const accent = (text: string) => theme.fg("accent", text);
	const success = (text: string) => theme.fg("success", text);
	const dim = (text: string) => theme.fg("dim", text);
	const muted = (text: string) => theme.fg("muted", text);
	const loaded = data.loaded.length > 0 ? data.loaded : [["commands", 0] as [string, number]];
	const sessions = data.recentSessions.length > 0 ? data.recentSessions : [{ label: "none yet", age: "" }];

	return [
		"",
		accent(theme.bold("Tips")),
		`${dim("/help")} for keyboard shortcuts`,
		`${dim("/")}     for commands`,
		`${dim("!")}     to run bash`,
		"",
		accent(theme.bold("Loaded")),
		...loaded.map(([label, count]) => `${success("✓")} ${success(String(count))} ${label}`),
		"",
		accent(theme.bold("Recent sessions")),
		...sessions.slice(0, 3).map((session) => `${muted("•")} ${accent(session.label)} ${dim(session.age)}`),
	];
}

async function getDashboardData(ctx: ExtensionContext, pi: ExtensionAPI): Promise<DashboardData> {
	const model = ctx.model;
	const commands = pi.getCommands();
	const sessions = await getRecentSessions(ctx);

	return {
		model: model?.name ?? model?.id ?? "unknown model",
		provider: model?.provider ?? "unknown provider",
		cwd: ctx.cwd,
		loaded: [
			["extension commands", commands.filter((command) => command.source === "extension").length],
			["skills", commands.filter((command) => command.source === "skill").length],
			["prompt templates", commands.filter((command) => command.source === "prompt").length],
		],
		recentSessions: sessions,
	};
}

async function getRecentSessions(ctx: ExtensionContext): Promise<DashboardData["recentSessions"]> {
	try {
		const sessions = await SessionManager.list(ctx.cwd);
		return sessions
			.sort((a, b) => b.modified.getTime() - a.modified.getTime())
			.slice(0, 3)
			.map(formatSession);
	} catch {
		return [];
	}
}

function formatSession(session: SessionInfo): { label: string; age: string } {
	return {
		label: session.name || session.firstMessage || session.id.slice(0, 8),
		age: `(${formatAge(session.modified)})`,
	};
}

function formatAge(date: Date): string {
	const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

async function showDashboard(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	if (!ctx.hasUI) return;

	const data = await getDashboardData(ctx, pi);
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			new DashboardOverlay(data, theme, () => tui.requestRender(), () => done()),
		{
			overlay: true,
			overlayOptions: {
				width: 76,
				minWidth: 60,
				maxHeight: "80%",
				anchor: "center",
			},
		},
	);
}

export default function dashboardExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" && event.reason !== "new") return;
		await showDashboard(ctx, pi);
	});
}
