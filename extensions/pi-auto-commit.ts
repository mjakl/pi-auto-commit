import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { completeSimple, type AssistantMessage, type Model, type UserMessage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

type CommitModelConfig = { provider: string; model: string; thinking: ThinkingLevel };
type AutoCommitConfig = {
	defaultEnabled: boolean;
	commitModel?: CommitModelConfig;
	commitModelError?: string;
	messageInstructions: string[];
};

type ActivationResult = { ok: true } | { ok: false; reason: string };

type CommitMessage = { subject: string; body?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function normalizeInstructions(value: unknown): string[] {
	if (!Array.isArray(value)) return DEFAULT_MESSAGE_INSTRUCTIONS;
	const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return items.length > 0 ? items : DEFAULT_MESSAGE_INSTRUCTIONS;
}

function parseCommitModel(value: unknown): Pick<AutoCommitConfig, "commitModel" | "commitModelError"> {
	if (value === undefined) return {};
	if (!isRecord(value)) return { commitModelError: "Invalid commitModel config: expected an object." };
	if (typeof value.provider !== "string" || value.provider.trim() === "") {
		return { commitModelError: "Invalid commitModel config: provider is required." };
	}
	if (typeof value.model !== "string" || value.model.trim() === "") {
		return { commitModelError: "Invalid commitModel config: model is required." };
	}
	if (!isThinkingLevel(value.thinking)) {
		return { commitModelError: "Invalid commitModel config: thinking must be off, minimal, low, medium, high, or xhigh." };
	}
	return {
		commitModel: { provider: value.provider.trim(), model: value.model.trim(), thinking: value.thinking },
	};
}

function parseConfig(raw: unknown): AutoCommitConfig {
	const data = isRecord(raw) ? raw : {};
	return {
		defaultEnabled: data.defaultEnabled === true,
		...parseCommitModel(data.commitModel),
		messageInstructions: normalizeInstructions(data.messageInstructions),
	};
}

async function loadConfig(ctx: ExtensionContext): Promise<AutoCommitConfig> {
	try {
		return parseConfig(JSON.parse(await readFile(CONFIG_PATH, "utf8")));
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return parseConfig({});
		ctx.ui.notify(`Could not load pi-auto-commit config; using defaults. ${String(error)}`, "warning");
		return parseConfig({});
	}
}

async function execGit(pi: ExtensionAPI, ctx: ExtensionContext, args: string[]) {
	return pi.exec("git", args, { cwd: ctx.cwd, timeout: 15000 });
}

async function isInsideGitRepo(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
	const result = await execGit(pi, ctx, ["rev-parse", "--is-inside-work-tree"]);
	return result.code === 0 && result.stdout.trim() === "true";
}

async function getDirtyStatus(pi: ExtensionAPI, ctx: ExtensionContext) {
	const result = await execGit(pi, ctx, ["status", "--porcelain=v1", "-z"]);
	return result.code === 0 ? result.stdout : null;
}

async function checkActivation(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ActivationResult> {
	if (!(await isInsideGitRepo(pi, ctx))) {
		return { ok: false, reason: "Auto-commit can only be enabled inside a git repository." };
	}
	const status = await getDirtyStatus(pi, ctx);
	if (status === null) {
		return { ok: false, reason: "Could not inspect git status." };
	}
	if (status.length > 0) {
		return {
			ok: false,
			reason: "Auto-commit requires a clean git-visible worktree. Commit, clean, stash, or ignore files manually first.",
		};
	}
	return { ok: true };
}

function parsePorcelainEntries(zSeparated: string): string[] {
	return zSeparated.split("\0").map((s) => s.trim()).filter(Boolean);
}

function clip(text: string, max = 5000) {
	return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;
}

function extractText(msg: AssistantMessage): string {
	return msg.content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

function parseJsonCommit(text: string): CommitMessage {
	const data = JSON.parse(text) as unknown;
	if (!isRecord(data) || typeof data.subject !== "string" || data.subject.trim() === "") {
		throw new Error(`Invalid commit message JSON: ${clip(text)}`);
	}
	const body = typeof data.body === "string" && data.body.trim() ? data.body.trim() : undefined;
	return { subject: data.subject.trim(), body };
}

async function generateCommitMessage(pi: ExtensionAPI, ctx: ExtensionContext, config: AutoCommitConfig, changeSummary: string, changeReason?: string): Promise<CommitMessage> {
	if (config.commitModelError) throw new Error(config.commitModelError);
	const model = config.commitModel
		? ctx.modelRegistry.find(config.commitModel.provider, config.commitModel.model)
		: ctx.model;
	if (!model) throw new Error(config.commitModel ? `Commit model not found: ${config.commitModel.provider}/${config.commitModel.model}` : "No active model selected.");

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
	}

	const status = await execGit(pi, ctx, ["status", "--short"]);
	const statUnstaged = await execGit(pi, ctx, ["diff", "--stat"]);
	const statStaged = await execGit(pi, ctx, ["diff", "--cached", "--stat"]);
	const diffUnstaged = await execGit(pi, ctx, ["diff", "--no-ext-diff", "--no-color"]);
	const diffStaged = await execGit(pi, ctx, ["diff", "--cached", "--no-ext-diff", "--no-color"]);

	const prompt = [
		...config.messageInstructions.map((line) => `- ${line}`),
		"Return strict JSON only in this shape: {\"subject\":string,\"body\"?:string}",
		`change_summary: ${changeSummary}`,
		changeReason ? `change_reason: ${changeReason}` : undefined,
		`git status --short:\n${clip(status.stdout)}`,
		`git diff --stat:\n${clip(statUnstaged.stdout)}`,
		`git diff --cached --stat:\n${clip(statStaged.stdout)}`,
		`git diff:\n${clip(diffUnstaged.stdout)}`,
		`git diff --cached:\n${clip(diffStaged.stdout)}`,
	].filter(Boolean).join("\n\n");

	const response = await completeSimple(model as Model, {
		systemPrompt: prompt,
		messages: [{ role: "user", content: [{ type: "text", text: "Generate the commit message now." }], timestamp: Date.now() } satisfies UserMessage],
	}, { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal, reasoning });

	let message = parseJsonCommit(extractText(response));
	if (message.subject && message.subject.length > 0) return message;
	throw new Error("Commit message model did not return usable JSON.");
}

async function repairCommitMessage(pi: ExtensionAPI, ctx: ExtensionContext, model: Model, auth: { apiKey: string; headers?: Record<string, string> }, previous: string): Promise<CommitMessage> {
	const repair = await completeSimple(model, {
		systemPrompt: "Convert the previous output into strict JSON with keys subject and optional body only.",
		messages: [{ role: "user", content: [{ type: "text", text: previous }], timestamp: Date.now() } satisfies UserMessage],
	}, { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal, reasoning });
	return parseJsonCommit(extractText(repair));
}

async function getCommitMessage(pi: ExtensionAPI, ctx: ExtensionContext, config: AutoCommitConfig, changeSummary: string, changeReason?: string): Promise<CommitMessage> {
	const model = config.commitModel ? ctx.modelRegistry.find(config.commitModel.provider, config.commitModel.model) : ctx.model;
	if (!model) throw new Error(config.commitModel ? `Commit model not found: ${config.commitModel.provider}/${config.commitModel.model}` : "No active model selected.");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
	try {
		return await generateCommitMessage(pi, ctx, config, changeSummary, changeReason);
	} catch (error) {
		const previous = error instanceof Error ? error.message : String(error);
		try {
			return await repairCommitMessage(pi, ctx, model, { apiKey: auth.apiKey, headers: auth.headers }, previous);
		} catch {
			throw new Error("Commit message model output was invalid.");
		}
	}
}

async function checkpoint(pi: ExtensionAPI, ctx: ExtensionContext, config: AutoCommitConfig, changeSummary: string, changeReason?: string) {
	if (!enabledState.enabled) throw new Error("Auto-commit is disabled. This tool cannot commit. If the user explicitly asked for a commit, use the normal git workflow instead.");
	if (!(await isInsideGitRepo(pi, ctx))) throw new Error("Not inside a git repository.");
	if (await hasInProgressGitState(pi, ctx)) throw new Error("Git is mid-merge/rebase/cherry-pick. Finish or abort it first.");
	const dirty = await getDirtyStatus(pi, ctx);
	if (dirty === null) throw new Error("Could not inspect git status.");
	if (dirty.length === 0) return { content: [{ type: "text", text: "No git-visible changes to commit." }] };

	const commitMessage = await getCommitMessage(pi, ctx, config, changeSummary, changeReason);
	await execGit(pi, ctx, ["add", "-A"]);
	const check = await execGit(pi, ctx, ["diff", "--cached", "--check"]);
	if (check.code !== 0) throw new Error(check.stderr || check.stdout || "git diff --cached --check failed.");
	const commitArgs = ["commit", "-m", commitMessage.subject];
	if (commitMessage.body) commitArgs.push("-m", commitMessage.body);
	const committed = await execGit(pi, ctx, commitArgs);
	if (committed.code !== 0) throw new Error(committed.stderr || committed.stdout || "git commit failed.");
	const hash = (await execGit(pi, ctx, ["rev-parse", "--short", "HEAD"])).stdout.trim();
	return { content: [{ type: "text", text: `${hash} ${commitMessage.subject}` }] };
}

const enabledState = { enabled: false };

export default function piAutoCommit(pi: ExtensionAPI) {
	let config: AutoCommitConfig = parseConfig({});

	function setEnabled(ctx: ExtensionContext, next: boolean) {
		enabledState.enabled = next;
		ctx.ui.setStatus("autocommit", next ? "autocommit" : undefined);
	}

	pi.registerCommand("autocommit", {
		description: "Toggle auto-commit for this session",
		handler: async (_args, ctx) => {
			if (enabledState.enabled) {
				setEnabled(ctx, false);
				ctx.ui.notify("Auto-commit disabled.", "info");
				return;
			}
			const activation = await checkActivation(pi, ctx);
			if (!activation.ok) {
				ctx.ui.notify(activation.reason, "error");
				return;
			}
			setEnabled(ctx, true);
			ctx.ui.notify("Auto-commit enabled.", "info");
		},
	});

	pi.registerTool({
		name: "auto_commit_checkpoint",
		label: "Auto Commit Checkpoint",
		description: "Commit a coherent git-visible change checkpoint.",
		parameters: Type.Object({
			change_summary: Type.String(),
			change_reason: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return checkpoint(pi, ctx, config, params.change_summary, params.change_reason);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig(ctx);
		setEnabled(ctx, false);
		if (!config.defaultEnabled) return;
		const activation = await checkActivation(pi, ctx);
		if (!activation.ok) {
			ctx.ui.notify(activation.reason, "warning");
			return;
		}
		setEnabled(ctx, true);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		return {
			systemPrompt: enabledState.enabled
				? `${ctx.getSystemPrompt()}\n\nAuto-commit is enabled. When you complete a coherent, git-visible change, call auto_commit_checkpoint before asking the user for more input.`
				: `${ctx.getSystemPrompt()}\n\nAuto-commit is disabled. Do not call auto_commit_checkpoint unless the user explicitly asks for the normal git workflow.`,
		};
	});
}
