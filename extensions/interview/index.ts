import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { matchesKey, truncateToWidth, visibleWidth, type Focusable, type TUI } from "@earendil-works/pi-tui";

const optionSchema = Type.Object({
	value: Type.String({ description: "Stable value returned when this option is selected" }),
	label: Type.String({ description: "Short option label shown to the user" }),
	description: Type.Optional(Type.String({ description: "One-line helper text shown under the label" })),
	preview: Type.Optional(Type.String({ description: "Optional code, ASCII diagram, or plain text preview shown when this option is highlighted" })),
});

const questionSchema = Type.Object({
	id: Type.String({ description: "Stable question id" }),
	title: Type.String({ description: "Question text shown to the user" }),
	type: StringEnum(["single", "multi"] as const),
	options: Type.Array(optionSchema),
	allowCustom: Type.Optional(Type.Boolean({ description: "Allow the user to type a custom answer" })),
});

const interviewSchema = Type.Object({
	title: Type.Optional(Type.String({ description: "Short interview title" })),
	questions: Type.Array(questionSchema, { minItems: 1 }),
});

type InterviewInput = Static<typeof interviewSchema>;
type Question = InterviewInput["questions"][number];
type Option = Question["options"][number];

type Answer = {
	questionId: string;
	type: "single" | "multi";
	selected: string[];
	custom?: string;
};

type InterviewResult =
	| { status: "submitted"; answers: Answer[] }
	| { status: "cancelled" }
	| { status: "chat"; questionId: string; question: string; selected: string[]; custom?: string };

class InterviewPanel implements Focusable {
	focused = false;
	private questionIndex = 0;
	private selectedRow = 0;
	private typingCustom = false;
	private reviewMode = false;
	private readonly selected = new Map<string, Set<string>>();
	private readonly custom = new Map<string, string>();

	constructor(
		private input: InterviewInput,
		private tui: TUI,
		private theme: any,
		private done: (result: InterviewResult) => void,
	) {}

	handleInput(data: string): void {
		if (this.typingCustom) {
			this.handleCustomInput(data);
			return;
		}

		if (matchesKey(data, "escape")) return this.done({ status: "cancelled" });
		if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else if (matchesKey(data, "tab") || matchesKey(data, "right")) this.next();
		else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) this.prev();
		else if (matchesKey(data, "return") || data === " ") this.activate();
		else return;

		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const q = this.question;
		const rows = this.rowCount(q);
		this.selectedRow = Math.min(this.selectedRow, rows - 1);
		const selected = this.selectedFor(q);
		const lines: string[] = [];

		lines.push(th.fg("border", "─".repeat(Math.max(0, width))));
		lines.push(this.progress(width));
		lines.push("");
		if (this.reviewMode) {
			lines.push(th.fg("accent", truncateToWidth("Review answers", width, "")));
			lines.push("");
			lines.push(...this.answerOverview(width));
			lines.push(th.fg("border", "─".repeat(Math.max(0, width))));
			lines.push(this.formatActionLine(" Submit", width, true));
		} else {
			lines.push(th.fg("accent", truncateToWidth(q.title, width, "")));
			lines.push("");
			lines.push(...this.renderQuestionBody(q, selected, width, rows));
		}
		lines.push("");
		lines.push(th.fg("dim", "Enter select · Tab/←/→ navigate · Esc cancel"));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {}

	private get question(): Question {
		return this.input.questions[this.questionIndex];
	}

	private formatOptionLine(text: string, width: number, active: boolean, checked: boolean, description = false): string {
		const th = this.theme;
		const line = padToWidth(truncateToWidth(text, width, ""), width);
		if (active) return th.bg("selectedBg", th.fg(checked ? "success" : "accent", line));
		if (checked) return th.fg(description ? "muted" : "success", line);
		if (description) return th.fg("dim", line);
		return line;
	}

	private formatActionLine(text: string, width: number, active: boolean): string {
		const line = padToWidth(truncateToWidth(text, width, ""), width);
		return active ? this.theme.bg("selectedBg", this.theme.fg("accent", line)) : line;
	}

	private renderQuestionBody(question: Question, selected: Set<string>, width: number, rows: number): string[] {
		const optionLines = this.renderOptionLines(question, selected, width);
		const preview = this.selectedPreview(question);
		const bodyLines = preview && width >= 100 ? sideBySide(optionLines, this.renderPreview(preview, Math.floor(width * 0.45)), width) : optionLines;
		return [
			...bodyLines,
			...(preview && width < 100 ? ["", ...this.renderPreview(preview, width)] : []),
			this.theme.fg("border", "─".repeat(Math.max(0, width))),
			this.formatActionLine(this.chatRow(question), width, this.selectedRow === rows - 2),
			this.formatActionLine(this.submitRow(question), width, false),
		];
	}

	private renderOptionLines(question: Question, selected: Set<string>, width: number): string[] {
		const lines: string[] = [];
		question.options.forEach((option, i) => {
			const active = this.selectedRow === i;
			const checked = selected.has(option.value);
			const marker = active ? "❯" : " ";
			const checkbox = question.type === "multi" ? `[${checked ? "x" : " "}]` : checked ? "●" : "○";
			const label = `${marker} ${i + 1}. ${checkbox} ${option.label}`;
			lines.push(this.formatOptionLine(label, width, active, checked));
			if (option.description) lines.push(this.formatOptionLine(`   ${option.description}`, width, active, checked, true));
		});

		if (question.allowCustom) {
			const row = question.options.length;
			const active = this.selectedRow === row;
			const value = this.custom.get(question.id) ?? "";
			const cursor = this.typingCustom ? "█" : "";
			const prompt = this.typingCustom ? "Editing custom answer" : "Type something";
			const prefix = `${active ? "❯" : " "} ${row + 1}. ${prompt}`;
			const wrapped = wrapCustomAnswer(prefix, value || this.typingCustom ? `${value}${cursor}` : "", width);
			lines.push(...wrapped.map((line) => this.formatOptionLine(line, width, active, Boolean(value.trim()))));
			if (active) lines.push(this.theme.fg("dim", this.typingCustom ? "   Type text · Enter save · Esc stop editing" : "   Enter to edit custom answer"));
		}
		return lines;
	}

	private selectedPreview(question: Question): string | undefined {
		if (this.selectedRow < 0 || this.selectedRow >= question.options.length) return undefined;
		return question.options[this.selectedRow].preview?.trim() || undefined;
	}

	private renderPreview(preview: string, width: number): string[] {
		const innerWidth = Math.max(10, width - 4);
		const border = (text: string) => this.theme.fg("border", text);
		const rawLines = preview.replace(/^\n+|\n+$/g, "").split("\n").slice(0, 14);
		const lines = rawLines.map((line) => padToWidth(truncateToWidth(line, innerWidth, ""), innerWidth));
		return [
			border(`╭${"─".repeat(innerWidth + 2)}╮`),
			`${border("│ ")}${this.theme.fg("muted", padToWidth("Preview", innerWidth))}${border(" │")}`,
			border(`├${"─".repeat(innerWidth + 2)}┤`),
			...lines.map((line) => `${border("│ ")}${line}${border(" │")}`),
			border(`╰${"─".repeat(innerWidth + 2)}╯`),
		];
	}

	private selectedFor(question: Question): Set<string> {
		let values = this.selected.get(question.id);
		if (!values) {
			values = new Set();
			this.selected.set(question.id, values);
		}
		return values;
	}

	private rowCount(question: Question): number {
		return question.options.length + (question.allowCustom ? 1 : 0) + 2;
	}

	private move(delta: number): void {
		const rows = this.rowCount(this.question);
		this.selectedRow = Math.max(0, Math.min(rows - 1, this.selectedRow + delta));
	}

	private next(): void {
		if (this.reviewMode) {
			this.reviewMode = false;
			this.questionIndex = 0;
			this.selectedRow = 0;
			return;
		}
		if (this.questionIndex < this.input.questions.length - 1) {
			this.questionIndex++;
			this.selectedRow = 0;
		} else {
			this.reviewMode = true;
			this.selectedRow = 0;
		}
	}

	private prev(): void {
		if (this.reviewMode) {
			this.reviewMode = false;
			this.questionIndex = this.input.questions.length - 1;
			this.selectedRow = 0;
			return;
		}
		if (this.questionIndex > 0) {
			this.questionIndex--;
			this.selectedRow = 0;
		}
	}

	private activate(): void {
		if (this.reviewMode) return this.submit();
		const q = this.question;
		if (this.selectedRow < q.options.length) return this.toggleOption(q, q.options[this.selectedRow]);
		if (q.allowCustom && this.selectedRow === q.options.length) {
			this.typingCustom = true;
			return;
		}
		if (this.selectedRow === this.rowCount(q) - 2) {
			return this.done({ status: "chat", questionId: q.id, question: q.title, selected: [...this.selectedFor(q)], custom: this.custom.get(q.id) });
		}
		this.reviewMode = true;
	}

	private submit(): void {
		this.done({ status: "submitted", answers: this.input.questions.map((question) => ({
			questionId: question.id,
			type: question.type,
			selected: [...this.selectedFor(question)],
			custom: this.custom.get(question.id),
		})) });
	}

	private toggleOption(question: Question, option: Option): void {
		const values = this.selectedFor(question);
		if (question.type === "single") {
			values.clear();
			values.add(option.value);
			this.next();
			return;
		}
		if (values.has(option.value)) values.delete(option.value);
		else values.add(option.value);
	}

	private handleCustomInput(data: string): void {
		const q = this.question;
		if (matchesKey(data, "escape")) this.typingCustom = false;
		else if (matchesKey(data, "return")) {
			this.typingCustom = false;
			this.next();
		} else if (matchesKey(data, "backspace")) {
			const value = this.custom.get(q.id) ?? "";
			this.custom.set(q.id, value.slice(0, -1));
		} else if (data.length === 1 && data >= " ") {
			this.custom.set(q.id, `${this.custom.get(q.id) ?? ""}${data}`);
		} else return;
		this.tui.requestRender();
	}

	private progress(width: number): string {
		const th = this.theme;
		const onSubmit = this.reviewMode;
		const parts = [
			th.fg("dim", "←"),
			...this.input.questions.map((q, i) => {
				const active = i === this.questionIndex && !onSubmit;
				const text = `${this.hasAnswer(q) ? "☑" : "☐"} ${q.id}`;
				if (active) return th.fg("accent", th.bold(text));
				if (this.hasAnswer(q)) return th.fg("success", text);
				return th.fg("dim", text);
			}),
			onSubmit ? th.fg("accent", th.bold("✔ Submit")) : th.fg("dim", "✔ Submit"),
			th.fg("dim", "→"),
		];
		return truncateToWidth(parts.join("  "), width, "");
	}

	private hasAnswer(question: Question): boolean {
		return this.selectedFor(question).size > 0 || Boolean(this.custom.get(question.id)?.trim());
	}

	private answerOverview(width: number): string[] {
		const th = this.theme;
		return this.input.questions.flatMap((question) => {
			const labels = question.options.filter((option) => this.selectedFor(question).has(option.value)).map((option) => option.label);
			const custom = this.custom.get(question.id)?.trim();
			const answer = [...labels, ...(custom ? [custom] : [])].join(", ");
			const line = answer
				? ` ${th.fg("accent", question.id)}${th.fg("dim", ":")} ${th.fg("success", answer)}`
				: ` ${th.fg("accent", question.id)}${th.fg("dim", ":")} ${th.fg("muted", "—")}`;
			return [truncateToWidth(line, width, "")];
		});
	}

	private chatRow(question: Question): string {
		return ` ${this.rowNumber(question, 0)}. Chat about this`;
	}

	private submitRow(question: Question): string {
		return ` ${this.rowNumber(question, 1)}. Submit`;
	}

	private rowNumber(question: Question, offset: number): number {
		return question.options.length + (question.allowCustom ? 1 : 0) + 1 + offset;
	}
}

function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function sideBySide(left: string[], right: string[], width: number): string[] {
	const gap = 2;
	const rightWidth = Math.min(Math.floor(width * 0.45), Math.max(30, width - 40));
	const leftWidth = Math.max(20, width - rightWidth - gap);
	const rows = Math.max(left.length, right.length);
	return Array.from({ length: rows }, (_, i) => {
		const leftLine = truncateToWidth(left[i] ?? "", leftWidth, "");
		const rightLine = truncateToWidth(right[i] ?? "", rightWidth, "");
		return `${padToWidth(leftLine, leftWidth)}${" ".repeat(gap)}${rightLine}`;
	});
}

function wrapCustomAnswer(prefix: string, value: string, width: number): string[] {
	if (!value) return [prefix];
	const lines: string[] = [];
	let linePrefix = `${prefix}: `;
	let remaining = value;

	while (remaining.length > 0) {
		const available = Math.max(8, width - visibleWidth(linePrefix));
		let chunk = remaining.slice(0, available);
		if (remaining.length > available) {
			const breakAt = Math.max(chunk.lastIndexOf(" "), chunk.lastIndexOf("\t"));
			if (breakAt > 0) chunk = chunk.slice(0, breakAt);
		}
		lines.push(`${linePrefix}${chunk}`);
		remaining = remaining.slice(chunk.length).replace(/^\s+/, "");
		linePrefix = "   ";
	}

	return lines;
}

export default function interviewExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "interview_user",
		label: "Interview User",
		description: "Ask the user structured single-choice or multi-choice questions in an interactive UI and return their answers.",
		promptSnippet: "Ask the user structured questions with a temporary interview UI.",
		promptGuidelines: [
			"Use interview_user when you need the user's answers to several structured questions before choosing an implementation plan.",
			"Do not use interview_user for a single simple clarification that can be asked conversationally.",
		],
		parameters: interviewSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: "interview_user requires interactive UI mode." }], details: {}, isError: true };
			}

			const result = await ctx.ui.custom<InterviewResult>((tui, theme, _keybindings, done) => {
				return new InterviewPanel(params, tui, theme, done);
			});

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});
}
