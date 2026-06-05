import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(getAgentDir(), "extensions", "pi-auto-commit.json");

const DEFAULT_MESSAGE_INSTRUCTIONS = [
	"Keep commit messages short.",
	"Use imperative mood.",
	"Start the subject with an uppercase letter, then sentence case.",
	"Do not use conventional commit prefixes like feat: or fix:.",
	"Write a body only when it adds useful context beyond the subject.",
];

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

interface CommitModelConfig {
	provider: string;
	model: string;
	thinking: ThinkingLevel;
}

interface AutoCommitConfig {
	defaultEnabled: boolean;
	commitModel?: CommitModelConfig;
	commitModelError?: string;
	messageInstructions: string[];
}

interface ActivationResult {
	ok: boolean;
	reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function parseCommitModel(value: unknown): Pick<AutoCommitConfig, "commitModel" | "commitModelError"> {
	if (value === undefined) return {};
	if (!isRecord(value)) {
		return { commitModelError: "Invalid commitModel config: expected an object." };
	}

	const provider = value.provider;
	const model = value.model;
	const thinking = value.thinking;

	if (typeof provider !== "string" || provider.trim() === "") {
		return { commitModelError: "Invalid commitModel config: provider is required." };
	}
	if (typeof model !== "string" || model.trim() === "") {
		return { commitModelError: "Invalid commitModel config: model is required." };
	}
	if (!isThinkingLevel(thinking)) {
		return { commitModelError: "Invalid commitModel config: thinking must be off, minimal, low, medium, high, or xhigh." };
	}

	return {
		commitModel: {
			provider: provider.trim(),
			model: model.trim(),
			thinking,
		},
	};
}

function parseConfig(raw: unknown): AutoCommitConfig {
	const data = isRecord(raw) ? raw : {};
	const messageInstructions = Array.isArray(data.messageInstructions)
		? data.messageInstructions.filter((item): item is string => typeof item === "string" && item.trim() !== "")
		: DEFAULT_MESSAGE_INSTRUCTIONS;

	return {
		defaultEnabled: data.defaultEnabled === true,
		...parseCommitModel(data.commitModel),
		messageInstructions: messageInstructions.length > 0 ? messageInstructions : DEFAULT_MESSAGE_INSTRUCTIONS,
	};
}

async function loadConfig(ctx: ExtensionContext): Promise<AutoCommitConfig> {
	try {
		const text = await readFile(CONFIG_PATH, "utf8");
		return parseConfig(JSON.parse(text));
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") {
			return parseConfig({});
		}
		ctx.ui.notify(`Could not load pi-auto-commit config; using defaults. ${String(error)}`, "warning");
		return parseConfig({});
	}
}

async function checkActivation(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ActivationResult> {
	const repo = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ctx.cwd, timeout: 5000 });
	if (repo.code !== 0 || repo.stdout.trim() !== "true") {
		return { ok: false, reason: "Auto-commit can only be enabled inside a git repository." };
	}

	const status = await pi.exec("git", ["status", "--porcelain=v1", "-z"], { cwd: ctx.cwd, timeout: 5000 });
	if (status.code !== 0) {
		return { ok: false, reason: `Could not inspect git status: ${status.stderr.trim() || status.stdout.trim()}` };
	}
	if (status.stdout.length > 0) {
		return {
			ok: false,
			reason: "Auto-commit requires a clean git-visible worktree. Commit, clean, stash, or ignore files manually first.",
		};
	}

	return { ok: true };
}

export default function piAutoCommit(pi: ExtensionAPI) {
	let config: AutoCommitConfig = parseConfig({});
	let enabled = false;

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig(ctx);
		enabled = false;

		if (!config.defaultEnabled) return;

		const activation = await checkActivation(pi, ctx);
		if (!activation.ok) {
			ctx.ui.notify(activation.reason ?? "Auto-commit could not be enabled.", "warning");
			return;
		}

		enabled = true;
	});
}
