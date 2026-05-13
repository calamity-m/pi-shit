import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";

export const MODEL_TIER_NAMES = ["lightning", "fast", "default", "strong", "oracle"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ModelTierName = (typeof MODEL_TIER_NAMES)[number];
export type ModelTierThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ModelTierMapping = {
	model: string;
	thinkingLevel?: ModelTierThinkingLevel;
};

export type ModelTierConfig = Partial<Record<ModelTierName, ModelTierMapping>>;

export type ModelTierConfigSource = "project" | "global" | "none";

export type ModelTierConfigPaths = {
	project: string;
	global: string;
};

export type LoadedModelTierConfig = {
	config: ModelTierConfig;
	source: ModelTierConfigSource;
	path?: string;
	paths: ModelTierConfigPaths;
};

export type ResolvedModelTier = {
	tier: ModelTierName;
	model: Model<any>;
	modelId: string;
	thinkingLevel?: ModelTierThinkingLevel;
};

export type TierValidationIssue = {
	tier: ModelTierName;
	modelId?: string;
	type: "invalid-model-id" | "unknown-model" | "unavailable-model" | "invalid-thinking-level";
	message: string;
};

export class ModelTierConfigError extends Error {
	constructor(
		message: string,
		readonly path?: string,
	) {
		super(path ? `${message}: ${path}` : message);
		this.name = "ModelTierConfigError";
	}
}

export class ModelTierResolutionError extends Error {
	constructor(
		message: string,
		readonly tier?: ModelTierName,
		readonly modelId?: string,
	) {
		super(message);
		this.name = "ModelTierResolutionError";
	}
}

export function isModelTierName(value: string): value is ModelTierName {
	return (MODEL_TIER_NAMES as readonly string[]).includes(value);
}

export function isModelTierThinkingLevel(value: string): value is ModelTierThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function getModelTierConfigPaths(cwd: string, agentDir = getAgentDir()): ModelTierConfigPaths {
	return {
		project: join(cwd, ".pi", "model-tiers.json"),
		global: join(agentDir, "model-tiers.json"),
	};
}

export function createEmptyModelTierConfig(): ModelTierConfig {
	return {};
}

export function createModelTierConfigTemplate(): ModelTierConfig {
	return Object.fromEntries(MODEL_TIER_NAMES.map((tier) => [tier, { model: "provider/model-id" }])) as ModelTierConfig;
}

export async function loadModelTierConfig(cwd: string, agentDir = getAgentDir()): Promise<LoadedModelTierConfig> {
	const paths = getModelTierConfigPaths(cwd, agentDir);
	for (const [source, path] of [
		["project", paths.project],
		["global", paths.global],
	] as const) {
		const raw = await readOptionalFile(path);
		if (raw == null) continue;
		return { config: parseModelTierConfig(raw, path), source, path, paths };
	}
	return { config: createEmptyModelTierConfig(), source: "none", paths };
}

export async function saveModelTierConfig(config: ModelTierConfig, path: string): Promise<void> {
	const issues = validateModelTierConfigShape(config);
	if (issues.length > 0) {
		throw new ModelTierConfigError(issues.map((issue) => issue.message).join("\n"), path);
	}
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}

export function updateDefaultTier(config: ModelTierConfig, model: Model<any>, thinkingLevel?: ModelTierThinkingLevel): ModelTierConfig {
	return {
		...config,
		default: {
			model: formatCanonicalModelId(model),
			...(thinkingLevel ? { thinkingLevel } : {}),
		},
	};
}

export function formatCanonicalModelId(model: Pick<Model<any>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export function parseCanonicalModelId(modelId: string): { provider: string; modelId: string } {
	const slash = modelId.indexOf("/");
	if (slash <= 0 || slash === modelId.length - 1) {
		throw new ModelTierConfigError(`Model id must use canonical provider/model-id form: ${modelId}`);
	}
	return { provider: modelId.slice(0, slash), modelId: modelId.slice(slash + 1) };
}

export function resolveModelTier(
	config: ModelTierConfig,
	tier: ModelTierName,
	modelRegistry: ModelRegistry,
): ResolvedModelTier {
	const mapping = config[tier];
	if (!mapping) throw new ModelTierResolutionError(`No model configured for tier "${tier}"`, tier);

	const issue = validateModelTierMapping(tier, mapping, modelRegistry);
	if (issue) throw new ModelTierResolutionError(issue.message, tier, mapping.model);

	const { provider, modelId } = parseCanonicalModelId(mapping.model);
	const model = modelRegistry.find(provider, modelId);
	if (!model) throw new ModelTierResolutionError(`Unknown model for tier "${tier}": ${mapping.model}`, tier, mapping.model);

	return {
		tier,
		model,
		modelId: mapping.model,
		thinkingLevel: mapping.thinkingLevel,
	};
}

export function validateModelTierAvailability(config: ModelTierConfig, modelRegistry: ModelRegistry): TierValidationIssue[] {
	const shapeIssues = validateModelTierConfigShape(config);
	const availabilityIssues = MODEL_TIER_NAMES.flatMap((tier) => {
		const mapping = config[tier];
		if (!mapping) return [];
		const issue = validateModelTierMapping(tier, mapping, modelRegistry);
		return issue ? [issue] : [];
	});
	return [...shapeIssues, ...availabilityIssues];
}

function validateModelTierMapping(
	tier: ModelTierName,
	mapping: ModelTierMapping,
	modelRegistry: ModelRegistry,
): TierValidationIssue | undefined {
	if (!isModelTierThinkingLevel(mapping.thinkingLevel ?? "off")) {
		return {
			tier,
			modelId: mapping.model,
			type: "invalid-thinking-level",
			message: `Tier "${tier}" has invalid thinkingLevel: ${String(mapping.thinkingLevel)}`,
		};
	}

	let parsed: { provider: string; modelId: string };
	try {
		parsed = parseCanonicalModelId(mapping.model);
	} catch {
		return {
			tier,
			modelId: mapping.model,
			type: "invalid-model-id",
			message: `Tier "${tier}" model must use canonical provider/model-id form: ${mapping.model}`,
		};
	}

	const model = modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) {
		return {
			tier,
			modelId: mapping.model,
			type: "unknown-model",
			message: `Tier "${tier}" references an unknown model: ${mapping.model}`,
		};
	}
	if (!modelRegistry.hasConfiguredAuth(model)) {
		return {
			tier,
			modelId: mapping.model,
			type: "unavailable-model",
			message: `Tier "${tier}" model is known but unavailable; authenticate provider "${parsed.provider}" or configure its API key: ${mapping.model}`,
		};
	}
}

function parseModelTierConfig(raw: string, path: string): ModelTierConfig {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ModelTierConfigError(`Invalid model tier JSON (${message})`, path);
	}

	const config = normalizeModelTierConfig(value, path);
	const issues = validateModelTierConfigShape(config);
	if (issues.length > 0) {
		throw new ModelTierConfigError(issues.map((issue) => issue.message).join("\n"), path);
	}
	return config;
}

function normalizeModelTierConfig(value: unknown, path: string): ModelTierConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ModelTierConfigError("Model tier config must be a JSON object", path);
	}

	const config: ModelTierConfig = {};
	for (const [tier, mapping] of Object.entries(value)) {
		if (!isModelTierName(tier)) {
			throw new ModelTierConfigError(`Unknown model tier "${tier}"`, path);
		}
		if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
			throw new ModelTierConfigError(`Tier "${tier}" must be an object`, path);
		}

		const model = (mapping as { model?: unknown }).model;
		const thinkingLevel = (mapping as { thinkingLevel?: unknown }).thinkingLevel;
		config[tier] = {
			model: typeof model === "string" ? model : "",
			...(thinkingLevel === undefined ? {} : { thinkingLevel: String(thinkingLevel) as ModelTierThinkingLevel }),
		};
	}
	return config;
}

function validateModelTierConfigShape(config: ModelTierConfig): TierValidationIssue[] {
	return MODEL_TIER_NAMES.flatMap((tier) => {
		const mapping = config[tier];
		if (!mapping) return [];
		const issues: TierValidationIssue[] = [];
		if (!mapping.model || typeof mapping.model !== "string") {
			issues.push({
				tier,
				type: "invalid-model-id",
				message: `Tier "${tier}" must have a string model`,
			});
		}
		if (mapping.thinkingLevel !== undefined && !isModelTierThinkingLevel(mapping.thinkingLevel)) {
			issues.push({
				tier,
				modelId: mapping.model,
				type: "invalid-thinking-level",
				message: `Tier "${tier}" has invalid thinkingLevel: ${String(mapping.thinkingLevel)}`,
			});
		}
		return issues;
	});
}

async function readOptionalFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw new ModelTierConfigError("Could not read model tier config", path);
	}
}

function isNotFound(error: unknown): boolean {
	return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
