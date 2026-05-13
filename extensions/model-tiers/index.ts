import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import {
	MODEL_TIER_NAMES,
	THINKING_LEVELS,
	createModelTierConfigTemplate,
	formatCanonicalModelId,
	isModelTierName,
	isModelTierThinkingLevel,
	loadModelTierConfig,
	resolveModelTier,
	saveModelTierConfig,
	updateDefaultTier,
	validateModelTierAvailability,
	type LoadedModelTierConfig,
	type ModelTierConfig,
	type ModelTierName,
} from "../shared/model-tiers.js";

export default function (pi: ExtensionAPI) {
	let suppressDefaultUpdate = false;

	pi.on("session_start", async (_event, ctx) => {
		await updateTierStatus(ctx, pi);
	});

	pi.on("model_select", async (event, ctx) => {
		if (!suppressDefaultUpdate) {
			await updateExistingDefaultTier(ctx, event.model, pi.getThinkingLevel());
		}
		await updateTierStatus(ctx, pi);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		if (!suppressDefaultUpdate && ctx.model) {
			await updateExistingDefaultTier(ctx, ctx.model, event.level);
		}
		await updateTierStatus(ctx, pi);
	});

	pi.registerCommand("tier", {
		description: "Switch model/thinking by configured tier",
		getArgumentCompletions: (prefix) => MODEL_TIER_NAMES.filter((tier) => tier.startsWith(prefix)).map((tier) => ({ value: tier, label: tier })),
		handler: async (args, ctx) => {
			const tier = args.trim();
			if (!isModelTierName(tier)) {
				ctx.ui.notify(`Usage: /tier ${MODEL_TIER_NAMES.join("|")}`, "warning");
				return;
			}

			try {
				const loaded = await loadModelTierConfig(ctx.cwd);
				const resolved = resolveModelTier(loaded.config, tier, ctx.modelRegistry);
				suppressDefaultUpdate = tier !== "default";
				try {
					const ok = await pi.setModel(resolved.model);
					if (!ok) {
						ctx.ui.notify(`Tier "${tier}" model is not authenticated: ${resolved.modelId}`, "error");
						return;
					}
					if (resolved.thinkingLevel) pi.setThinkingLevel(resolved.thinkingLevel as ThinkingLevel);
				} finally {
					suppressDefaultUpdate = false;
				}
				ctx.ui.setStatus("tier", formatTierStatus(tier, resolved.modelId, resolved.thinkingLevel));
				ctx.ui.notify(`Switched to ${formatTierStatus(tier, resolved.modelId, resolved.thinkingLevel)}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("tiers", {
		description: "Pick a tier, model, and thinking level to configure",
		handler: async (args, ctx) => {
			const loaded = await loadModelTierConfig(ctx.cwd);
			if (args.trim() === "edit") {
				await editTierConfig(ctx, loaded);
				await updateTierStatus(ctx, pi);
				return;
			}
			if (args.trim() === "show") {
				ctx.ui.notify(formatTiersReport(loaded, ctx), "info");
				return;
			}
			await pickTierMapping(ctx, loaded);
			await updateTierStatus(ctx, pi);
		},
	});
}

async function updateExistingDefaultTier(ctx: ExtensionContext, model: Model<any>, thinkingLevel: ThinkingLevel): Promise<void> {
	try {
		const loaded = await loadModelTierConfig(ctx.cwd);
		if (!loaded.path) return;
		const next = updateDefaultTier(loaded.config, model, thinkingLevel);
		await saveModelTierConfig(next, loaded.path);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

async function updateTierStatus(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	try {
		if (!ctx.model) {
			ctx.ui.setStatus("tier", undefined);
			return;
		}
		const loaded = await loadModelTierConfig(ctx.cwd);
		const current = formatCanonicalModelId(ctx.model);
		const thinking = pi.getThinkingLevel();
		const matching = MODEL_TIER_NAMES.find((tier) => {
			const mapping = loaded.config[tier];
			return mapping?.model === current && (!mapping.thinkingLevel || mapping.thinkingLevel === thinking);
		});
		ctx.ui.setStatus("tier", matching ? formatTierStatus(matching, current, thinking) : undefined);
	} catch {
		ctx.ui.setStatus("tier", undefined);
	}
}

async function pickTierMapping(ctx: ExtensionContext, loaded: LoadedModelTierConfig): Promise<void> {
	const tier = await ctx.ui.select("Choose tier to configure", [...MODEL_TIER_NAMES]);
	if (!tier || !isModelTierName(tier)) return;

	const models = ctx.modelRegistry.getAvailable();
	if (models.length === 0) {
		ctx.ui.notify("No authenticated models available. Run /login or configure provider API keys first.", "warning");
		return;
	}

	const modelLabels = new Map(models.map((model) => [formatModelOption(model), model]));
	const modelChoice = await ctx.ui.select(`Choose model for ${tier}`, [...modelLabels.keys()]);
	if (!modelChoice) return;
	const model = modelLabels.get(modelChoice);
	if (!model) return;

	const supportedThinking = getSupportedThinkingLevels(model).filter((level) => (THINKING_LEVELS as readonly string[]).includes(level));
	const thinkingOptions = supportedThinking.length > 0 ? supportedThinking : ["off"];
	const thinkingLevel = await ctx.ui.select(`Choose thinking for ${tier}`, thinkingOptions);
	if (!thinkingLevel || !isModelTierThinkingLevel(thinkingLevel)) return;

	const path = loaded.path ?? loaded.paths.global;
	const config: ModelTierConfig = {
		...loaded.config,
		[tier]: { model: formatCanonicalModelId(model), thinkingLevel },
	};
	await saveModelTierConfig(config, path);
	ctx.ui.notify(`Saved ${formatTierStatus(tier, config[tier]!.model, thinkingLevel)} to ${path}`, "info");
}

async function editTierConfig(ctx: ExtensionContext, loaded: LoadedModelTierConfig): Promise<void> {
	const target = await ctx.ui.select("Save model tiers where?", ["project", "global"]);
	if (!target) return;
	const path = target === "project" ? loaded.paths.project : loaded.paths.global;
	const prefillConfig = loaded.source === target ? loaded.config : createModelTierConfigTemplate();
	const edited = await ctx.ui.editor(`Edit model tiers (${target}: ${path})`, `${JSON.stringify(prefillConfig, null, "\t")}\n`);
	if (edited == null) return;

	let config: ModelTierConfig;
	try {
		config = JSON.parse(edited) as ModelTierConfig;
		await saveModelTierConfig(config, path);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}

	const issues = validateModelTierAvailability(config, ctx.modelRegistry);
	const suffix = issues.length > 0 ? ` (${issues.length} validation issue${issues.length === 1 ? "" : "s"})` : "";
	ctx.ui.notify(`Saved model tiers to ${path}${suffix}`, issues.length > 0 ? "warning" : "info");
}

function formatModelOption(model: Model<any>): string {
	const canonical = formatCanonicalModelId(model);
	return model.name && model.name !== model.id ? `${canonical} · ${model.name}` : canonical;
}

function formatTiersReport(loaded: LoadedModelTierConfig, ctx: ExtensionContext): string {
	const source = loaded.path ? `${loaded.source}: ${loaded.path}` : `none (project: ${loaded.paths.project}; global: ${loaded.paths.global})`;
	const issues = validateModelTierAvailability(loaded.config, ctx.modelRegistry);
	const issueByTier = new Map(issues.map((issue) => [issue.tier, issue]));
	const lines = [`Model tiers`, `source: ${source}`, ``, `tier       model                                 thinking  status`, `---------  ------------------------------------  --------  ------`];
	for (const tier of MODEL_TIER_NAMES) {
		const mapping = loaded.config[tier];
		const issue = issueByTier.get(tier);
		lines.push([
			tier.padEnd(9),
			(mapping?.model ?? "—").padEnd(36).slice(0, 36),
			(mapping?.thinkingLevel ?? "—").padEnd(8),
			issue ? issue.type : mapping ? "ok" : "unset",
		].join("  "));
	}
	if (issues.length > 0) {
		lines.push("", "Validation:", ...issues.map((issue) => `- ${issue.message}`));
	}
	lines.push("", "Run /tiers to pick tier/model/thinking interactively, or /tiers edit for raw JSON.");
	return lines.join("\n");
}

function formatTierStatus(tier: ModelTierName, modelId: string, thinkingLevel?: string): string {
	return `${tier} · ${modelId}${isModelTierThinkingLevel(thinkingLevel ?? "") ? `:${thinkingLevel}` : ""}`;
}
