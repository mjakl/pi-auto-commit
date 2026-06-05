import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { completeSimple, type Api, type AssistantMessage, type Model, type UserMessage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExecResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CONFIG_PATH = join(getAgentDir(), "extensions", "pi-auto-commit.json");

const DEFAULT_MESSAGE_INSTRUCTIONS = [
	"Keep commit messages short.",
	"Use imperative mood.",
	"Start the subject with an uppercase letter, then sentence case.",
	"Do not use conventional commit prefixes like feat: or fix:.",
	"Write a body only when it adds useful context beyond the subject.",
];

const ENABLED_PROMPT = `Auto-commit is enabled.

When you complete a coherent, git-visible change, call \`auto_commit_checkpoint\`
with:
- \`change_summary\`: what changed
- \`change_reason\`: why it changed, if non-obvious

Call the checkpoint before asking the user for more input if the current
git-visible changes are coherent and ready to commit.

Call \`auto_commit_checkpoint\` as the only tool call in that assistant turn;
finish file and shell tool calls first.

Do not run \`git add\` or \`git commit\` yourself unless the user explicitly asks
you to use the normal git workflow.

Anything git-visible may be committed. Put scratch or non-deliverable files in
\`/tmp\`, a \`mktemp -d\` directory, or a git-ignored path. If a visible change
should not be committed, move it out of git visibility or ask the user.`;

const DISABLED_PROMPT = `Auto-commit is disabled.

Do not call \`auto_commit_checkpoint\`. If the user explicitly asks you to commit,
use the normal git workflow. Otherwise leave changes uncommitted.`;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type ReasoningLevel = Exclude<ThinkingLevel, "off">;

type CommitModelConfig = {
	provider: string;
	model: string;
	thinking: ThinkingLevel;
};

type AutoCommitConfig = {
	defaultEnabled: boolean;
	commitModel?: CommitModelConfig;
	commitModelError?: string;
	messageInstructions: string[];
};

type ActivationResult = { ok: true } | { ok: false; reason: string };
type CommitMessage = { subject: string; body?: string };
type GitContext = {
	statusShort: string;
	unstagedStat: string;
	stagedStat: string;
	unstagedDiff: string;
	stagedDiff: string;
};

type SelectedCommitModel = {
	model: Model<Api>;
	apiKey: string;
	headers?: Record<string, string>;
	reasoning?: ReasoningLevel;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function reasoningFromThinking(thinking: ThinkingLevel): ReasoningLevel | undefined {
	return thinking === "off" ? undefined : thinking;
}

function normalizeInstructions(value: unknown): string[] {
	if (!Array.isArray(value)) return DEFAULT_MESSAGE_INSTRUCTIONS;

	const instructions = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);

	return instructions.length > 0 ? instructions : DEFAULT_MESSAGE_INSTRUCTIONS;
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
		return {
			commitModelError:
				"Invalid commitModel config: thinking must be off, minimal, low, medium, high, or xhigh.",
		};
	}

	return {
		commitModel: {
			provider: value.provider.trim(),
			model: value.model.trim(),
			thinking: value.thinking,
		},
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
		const text = await readFile(CONFIG_PATH, "utf8");
		return parseConfig(JSON.parse(text));
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return parseConfig({});

		ctx.ui.notify(`Could not load pi-auto-commit config; using defaults. ${errorText(error)}`, "warning");
		return parseConfig({});
	}
}

async function execGit(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	args: string[],
	timeout = 15000,
	signal?: AbortSignal,
): Promise<ExecResult> {
	return pi.exec("git", args, { cwd: ctx.cwd, timeout, signal: signal ?? ctx.signal });
}

function gitFailure(command: string, result: ExecResult): Error {
	const output = (result.stderr || result.stdout).trim();
	return new Error(output ? `${command} failed: ${output}` : `${command} failed with exit code ${result.code}.`);
}

async function gitStdout(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	args: string[],
	timeout?: number,
	signal?: AbortSignal,
): Promise<string> {
	const result = await execGit(pi, ctx, args, timeout, signal);
	if (result.code !== 0) throw gitFailure(`git ${args.join(" ")}`, result);
	return result.stdout;
}

async function isInsideGitRepo(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal): Promise<boolean> {
	const result = await execGit(pi, ctx, ["rev-parse", "--is-inside-work-tree"], 5000, signal);
	return result.code === 0 && result.stdout.trim() === "true";
}

async function getPorcelainStatus(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
	return gitStdout(pi, ctx, ["status", "--porcelain=v1", "-z"], 5000, signal);
}

async function checkActivation(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ActivationResult> {
	if (!(await isInsideGitRepo(pi, ctx))) {
		return { ok: false, reason: "Auto-commit can only be enabled inside a git repository." };
	}

	let inProgress: string[];
	try {
		inProgress = await getInProgressGitState(pi, ctx);
	} catch (error) {
		return { ok: false, reason: `Could not inspect git state: ${errorText(error)}` };
	}
	if (inProgress.length > 0) {
		return {
			ok: false,
			reason: `Auto-commit cannot be enabled while git has an operation in progress (${inProgress.join(", ")}). Finish or abort it first.`,
		};
	}

	let status: string;
	try {
		status = await getPorcelainStatus(pi, ctx);
	} catch (error) {
		return { ok: false, reason: `Could not inspect git status: ${errorText(error)}` };
	}

	if (status.length > 0) {
		return {
			ok: false,
			reason: "Auto-commit requires a clean git-visible worktree. Commit, clean, stash, or ignore files manually first.",
		};
	}

	return { ok: true };
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function gitPath(pi: ExtensionAPI, ctx: ExtensionContext, path: string, signal?: AbortSignal): Promise<string> {
	const raw = (await gitStdout(pi, ctx, ["rev-parse", "--git-path", path], 5000, signal)).trim();
	return resolve(ctx.cwd, raw);
}

async function getInProgressGitState(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal): Promise<string[]> {
	const markers = [
		"MERGE_HEAD",
		"CHERRY_PICK_HEAD",
		"REVERT_HEAD",
		"REBASE_HEAD",
		"rebase-merge",
		"rebase-apply",
		"sequencer",
	];
	const present: string[] = [];

	for (const marker of markers) {
		if (await pathExists(await gitPath(pi, ctx, marker, signal))) {
			present.push(marker);
		}
	}

	return present;
}

function clip(text: string, maxChars = 12000): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n...[truncated]`;
}

async function collectGitContext(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal): Promise<GitContext> {
	const [statusShort, unstagedStat, stagedStat, unstagedDiff, stagedDiff] = await Promise.all([
		gitStdout(pi, ctx, ["status", "--short"], 5000, signal),
		gitStdout(pi, ctx, ["diff", "--stat"], 10000, signal),
		gitStdout(pi, ctx, ["diff", "--cached", "--stat"], 10000, signal),
		gitStdout(pi, ctx, ["diff", "--no-ext-diff", "--no-color"], 15000, signal),
		gitStdout(pi, ctx, ["diff", "--cached", "--no-ext-diff", "--no-color"], 15000, signal),
	]);

	return { statusShort, unstagedStat, stagedStat, unstagedDiff, stagedDiff };
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function jsonCandidate(text: string): string {
	let candidate = text.trim();
	const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fenced) candidate = fenced[1].trim();

	if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;

	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	return start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
}

function parseCommitMessageJson(text: string): CommitMessage | undefined {
	try {
		const data = JSON.parse(jsonCandidate(text)) as unknown;
		if (!isRecord(data)) return undefined;
		if (typeof data.subject !== "string" || data.subject.trim() === "") return undefined;
		if (data.body !== undefined && typeof data.body !== "string") return undefined;

		const body = typeof data.body === "string" && data.body.trim() !== "" ? data.body.trim() : undefined;
		return { subject: data.subject.trim(), body };
	} catch {
		return undefined;
	}
}

function buildCommitMessagePrompt(config: AutoCommitConfig, gitContext: GitContext, changeSummary: string, changeReason?: string): string {
	return `You write git commit messages for a Pi auto-commit extension.

Follow these instructions:
${config.messageInstructions.map((instruction) => `- ${instruction}`).join("\n")}

Return strict JSON only, with this shape:
{
  "subject": "Add auto-commit checkpoint flow",
  "body": "Keeps commit handling in the extension while the main agent only marks coherent change boundaries."
}

Use an empty body string when a body would not add useful context.

Agent-provided intent:
change_summary: ${changeSummary}
${changeReason ? `change_reason: ${changeReason}\n` : ""}
Git context:

# git status --short
${clip(gitContext.statusShort)}

# git diff --stat
${clip(gitContext.unstagedStat)}

# git diff --cached --stat
${clip(gitContext.stagedStat)}

# git diff
${clip(gitContext.unstagedDiff)}

# git diff --cached
${clip(gitContext.stagedDiff)}
`;
}

async function selectCommitModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: AutoCommitConfig,
): Promise<SelectedCommitModel> {
	if (config.commitModelError) throw new Error(config.commitModelError);

	const model = config.commitModel
		? ctx.modelRegistry.find(config.commitModel.provider, config.commitModel.model)
		: ctx.model;
	if (!model) {
		throw new Error(
			config.commitModel
				? `Commit model not found: ${config.commitModel.provider}/${config.commitModel.model}`
				: "No active model selected for commit-message generation.",
		);
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
	}

	const thinking = config.commitModel?.thinking ?? pi.getThinkingLevel();
	return {
		model,
		apiKey: auth.apiKey,
		headers: auth.headers,
		reasoning: reasoningFromThinking(thinking),
	};
}

async function callCommitMessageModel(
	ctx: ExtensionContext,
	selection: SelectedCommitModel,
	systemPrompt: string,
	userText: string,
	signal?: AbortSignal,
): Promise<string> {
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: userText }],
		timestamp: Date.now(),
	};

	const response = await completeSimple(
		selection.model,
		{ systemPrompt, messages: [userMessage] },
		{
			apiKey: selection.apiKey,
			headers: selection.headers,
			signal: signal ?? ctx.signal,
			reasoning: selection.reasoning,
			maxTokens: 1000,
		},
	);

	if (response.stopReason === "aborted") {
		throw new Error("Commit-message generation was cancelled.");
	}

	return extractText(response);
}

async function generateCommitMessage(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: AutoCommitConfig,
	gitContext: GitContext,
	changeSummary: string,
	changeReason?: string,
	signal?: AbortSignal,
): Promise<CommitMessage> {
	const selection = await selectCommitModel(pi, ctx, config);
	const prompt = buildCommitMessagePrompt(config, gitContext, changeSummary, changeReason);
	const initialOutput = await callCommitMessageModel(ctx, selection, prompt, "Generate the commit message JSON now.", signal);
	const initialMessage = parseCommitMessageJson(initialOutput);
	if (initialMessage) return initialMessage;

	const repairOutput = await callCommitMessageModel(
		ctx,
		selection,
		"Convert the user's previous output into strict JSON with only string keys subject and body. Return JSON only.",
		initialOutput,
		signal,
	);
	const repairedMessage = parseCommitMessageJson(repairOutput);
	if (repairedMessage) return repairedMessage;

	throw new Error("Commit message model output was invalid after one repair attempt.");
}

function latestAssistantToolCallCount(ctx: ExtensionContext): number {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!("role" in message) || message.role !== "assistant") continue;
		return message.content.filter((block) => block.type === "toolCall").length;
	}
	return 0;
}

async function commitCheckpoint(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: AutoCommitConfig,
	changeSummary: string,
	changeReason?: string,
	signal?: AbortSignal,
) {
	if (!(await isInsideGitRepo(pi, ctx, signal))) throw new Error("Not inside a git repository.");

	const inProgress = await getInProgressGitState(pi, ctx, signal);
	if (inProgress.length > 0) {
		throw new Error(`Git operation in progress (${inProgress.join(", ")}). Finish or abort it before checkpointing.`);
	}

	const status = await getPorcelainStatus(pi, ctx, signal);
	if (status.length === 0) {
		return {
			content: [{ type: "text" as const, text: "No git-visible changes to commit." }],
			details: { committed: false, reason: "clean" },
		};
	}

	const gitContext = await collectGitContext(pi, ctx, signal);
	const message = await generateCommitMessage(pi, ctx, config, gitContext, changeSummary, changeReason, signal);

	await gitStdout(pi, ctx, ["add", "-A"], undefined, signal);

	const diffCheck = await execGit(pi, ctx, ["diff", "--cached", "--check"], 15000, signal);
	if (diffCheck.code !== 0) throw gitFailure("git diff --cached --check", diffCheck);

	const commitArgs = ["commit", "-m", message.subject];
	if (message.body) commitArgs.push("-m", message.body);

	const commit = await execGit(pi, ctx, commitArgs, 30000, signal);
	if (commit.code !== 0) throw gitFailure("git commit", commit);

	const hash = (await gitStdout(pi, ctx, ["rev-parse", "--short", "HEAD"], 5000, signal)).trim();
	return {
		content: [{ type: "text" as const, text: `${hash} ${message.subject}` }],
		details: { committed: true, hash, subject: message.subject },
	};
}

export default function piAutoCommit(pi: ExtensionAPI) {
	let config: AutoCommitConfig = parseConfig({});
	let enabled = false;

	function setEnabled(ctx: ExtensionContext, next: boolean) {
		enabled = next;
		ctx.ui.setStatus("autocommit", next ? "autocommit" : undefined);
	}

	pi.registerCommand("autocommit", {
		description: "Toggle auto-commit for this session",
		handler: async (args, ctx) => {
			if (args.trim() !== "") {
				ctx.ui.notify("Usage: /autocommit", "error");
				return;
			}

			if (enabled) {
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
		description: "Commit all current git-visible changes at a coherent checkpoint when auto-commit is enabled.",
		parameters: Type.Object({
			change_summary: Type.String({ description: "What changed, in plain language." }),
			change_reason: Type.Optional(Type.String({ description: "Why it changed or important design context." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!enabled) {
				throw new Error(
					"Auto-commit is disabled. This tool cannot commit.\nIf the user explicitly asked for a commit, use the normal git workflow instead.",
				);
			}

			return commitCheckpoint(pi, ctx, config, params.change_summary, params.change_reason, signal);
		},
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "auto_commit_checkpoint") return;
		if (latestAssistantToolCallCount(ctx) <= 1) return;

		return {
			block: true,
			reason:
				"auto_commit_checkpoint must be the only tool call in its assistant turn. Finish other tool calls first, then call it in the next turn.",
		};
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
		ctx.ui.notify("Auto-commit enabled.", "info");
	});

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${enabled ? ENABLED_PROMPT : DISABLED_PROMPT}`,
	}));
}
