import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface CommandResult {
	stdout: string;
	stderr: string;
}

/** Per-execution options. A bare number is accepted as a timeout for back-compat. */
export interface PowerShellRunOptions {
	timeoutMs?: number;
	/** Working directory for the spawned process (sandbox lane points this at the sandbox root). */
	cwd?: string;
	/** Extra/overriding environment variables (sandbox lane redirects TEMP/TMP here). */
	env?: Record<string, string>;
	/** Hard cap on captured stdout/stderr length to bound memory. */
	maxOutputChars?: number;
	/** On timeout/abort, kill the whole process tree (taskkill /T) rather than just the shell. */
	killProcessTree?: boolean;
}

function normalizeRunOptions(opts?: number | PowerShellRunOptions): PowerShellRunOptions {
	if (typeof opts === "number") return { timeoutMs: opts };
	return opts ?? {};
}

export interface TimeoutResult {
	status: "timeout";
	executionId: string;
	elapsedSeconds: number;
	currentStdout: string;
	currentStderr: string;
	message: string;
}

export type PowerShellResult = CommandResult | TimeoutResult;

export function isTimeout(result: PowerShellResult): result is TimeoutResult {
	return (result as TimeoutResult).status === "timeout";
}

interface ProcessEntry {
	process: ChildProcessWithoutNullStreams;
	stdout: string;
	stderr: string;
	startTime: number;
	completed: boolean;
	exitCode: number | null;
	pendingResolvers: Array<(result: PowerShellResult) => void>;
	pendingTimeouts: NodeJS.Timeout[];
	maxOutputChars: number;
	killProcessTree: boolean;
}

const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;

/** Append a chunk to a captured stream, capping total length to bound memory. */
function appendCapped(current: string, chunk: string, max: number): string {
	if (current.length >= max) return current;
	const next = current + chunk;
	if (next.length <= max) return next;
	return `${next.slice(0, max)}\n…[output truncated at ${max} chars]`;
}

/** Terminate a process and (best effort) its whole child tree on Windows. */
function killProcessOrTree(child: ChildProcessWithoutNullStreams, tree: boolean): void {
	if (tree && process.platform === "win32" && child.pid) {
		try {
			spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
			return;
		} catch {
			// fall through to a plain kill
		}
	}
	try {
		child.kill();
	} catch {
		// Process may have already exited.
	}
}

const UTF8_PREFIX =
	"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " +
	"[Console]::InputEncoding = [System.Text.Encoding]::UTF8; ";

export class PowerShellService {
	private readonly processes = new Map<string, ProcessEntry>();
	private readonly logPath: string;
	readonly defaultTimeoutMs: number;

	constructor(logDir: string, defaultTimeoutMs = 30_000) {
		this.defaultTimeoutMs = defaultTimeoutMs;
		this.logPath = path.join(logDir, "powershell.log");
		fs.mkdirSync(logDir, { recursive: true });
	}

	execute(script: string, opts?: number | PowerShellRunOptions): Promise<PowerShellResult> {
		const options = normalizeRunOptions(opts);
		const ms = options.timeoutMs ?? this.defaultTimeoutMs;
		const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
		const executionId = randomUUID();
		const startTime = Date.now();

		this.writeLog({
			event: "execute",
			executionId,
			script,
			timeoutMs: ms,
			cwd: options.cwd,
			timestamp: new Date().toISOString(),
		});

		const child = spawn(
			"powershell.exe",
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", UTF8_PREFIX + script],
			{
				windowsHide: true,
				cwd: options.cwd,
				env: options.env ? { ...process.env, ...options.env } : process.env,
			},
		) as ChildProcessWithoutNullStreams;

		const entry: ProcessEntry = {
			process: child,
			stdout: "",
			stderr: "",
			startTime,
			completed: false,
			exitCode: null,
			pendingResolvers: [],
			pendingTimeouts: [],
			maxOutputChars,
			killProcessTree: options.killProcessTree ?? false,
		};
		this.processes.set(executionId, entry);

		child.stdout.on("data", (data: Buffer) => {
			entry.stdout = appendCapped(entry.stdout, data.toString("utf8"), entry.maxOutputChars);
		});
		child.stderr.on("data", (data: Buffer) => {
			entry.stderr = appendCapped(entry.stderr, data.toString("utf8"), entry.maxOutputChars);
		});

		child.on("close", (code) => {
			entry.completed = true;
			entry.exitCode = code;
			for (const timeoutHandle of entry.pendingTimeouts) clearTimeout(timeoutHandle);
			entry.pendingTimeouts = [];

			this.writeLog({
				event: "complete",
				executionId,
				exitCode: code,
				durationMs: Date.now() - startTime,
				stdoutLength: entry.stdout.length,
				stderrLength: entry.stderr.length,
				timestamp: new Date().toISOString(),
			});

			const result: CommandResult = { stdout: entry.stdout, stderr: entry.stderr };
			const resolvers = entry.pendingResolvers.splice(0);
			for (const resolve of resolvers) resolve(result);
			this.processes.delete(executionId);
		});

		child.on("error", (error) => {
			entry.completed = true;
			this.writeLog({
				event: "spawn_error",
				executionId,
				error: error.message,
				timestamp: new Date().toISOString(),
			});
			const result: CommandResult = { stdout: entry.stdout, stderr: error.message };
			const resolvers = entry.pendingResolvers.splice(0);
			for (const resolve of resolvers) resolve(result);
			this.processes.delete(executionId);
		});

		return this.waitWithTimeout(executionId, entry, ms);
	}

	continueExecution(executionId: string, newTimeoutMs: number): Promise<PowerShellResult> {
		const entry = this.processes.get(executionId);
		if (!entry) {
			return Promise.resolve({
				stdout: "",
				stderr: `[PowerShellService] Process ${executionId} already completed or does not exist.`,
			});
		}
		if (entry.completed) {
			return Promise.resolve({ stdout: entry.stdout, stderr: entry.stderr });
		}
		this.writeLog({
			event: "continue",
			executionId,
			newTimeoutMs,
			elapsedMs: Date.now() - entry.startTime,
			timestamp: new Date().toISOString(),
		});
		return this.waitWithTimeout(executionId, entry, newTimeoutMs);
	}

	abortExecution(executionId: string): void {
		const entry = this.processes.get(executionId);
		if (!entry) return;

		for (const timeoutHandle of entry.pendingTimeouts) clearTimeout(timeoutHandle);
		entry.pendingTimeouts = [];

		this.writeLog({
			event: "abort",
			executionId,
			elapsedMs: Date.now() - entry.startTime,
			timestamp: new Date().toISOString(),
		});

		killProcessOrTree(entry.process, entry.killProcessTree);

		const abortResult: CommandResult = {
			stdout: entry.stdout,
			stderr: `[aborted] Command was terminated manually.\n${entry.stderr}`,
		};
		const resolvers = entry.pendingResolvers.splice(0);
		for (const resolve of resolvers) resolve(abortResult);
		this.processes.delete(executionId);
	}

	private waitWithTimeout(executionId: string, entry: ProcessEntry, timeoutMs: number): Promise<PowerShellResult> {
		return new Promise<PowerShellResult>((resolve) => {
			if (entry.completed) {
				resolve({ stdout: entry.stdout, stderr: entry.stderr });
				return;
			}

			entry.pendingResolvers.push(resolve);

			const handle = setTimeout(() => {
				const resolverIndex = entry.pendingResolvers.indexOf(resolve);
				if (resolverIndex !== -1) entry.pendingResolvers.splice(resolverIndex, 1);

				const timeoutIndex = entry.pendingTimeouts.indexOf(handle);
				if (timeoutIndex !== -1) entry.pendingTimeouts.splice(timeoutIndex, 1);

				const elapsedSeconds = Math.round((Date.now() - entry.startTime) / 1000);

				this.writeLog({
					event: "timeout",
					executionId,
					elapsedSeconds,
					currentStdoutLength: entry.stdout.length,
					currentStderrLength: entry.stderr.length,
					timestamp: new Date().toISOString(),
				});

				resolve({
					status: "timeout",
					executionId,
					elapsedSeconds,
					currentStdout: entry.stdout,
					currentStderr: entry.stderr,
					message:
						`Command timed out after waiting ${elapsedSeconds} seconds. The process is still running.\n` +
						`Current output is available in currentStdout and currentStderr.\n\n` +
						`Next step options:\n` +
						`- Continue waiting: shell_command_continue({ "executionId": "${executionId}", "newTimeoutSeconds": <seconds> })\n` +
						`- Abort now: shell_command_abort({ "executionId": "${executionId}" })`,
				});
			}, timeoutMs);

			entry.pendingTimeouts.push(handle);
		});
	}

	private writeLog(data: Record<string, unknown>): void {
		try {
			fs.appendFileSync(this.logPath, `${JSON.stringify(data)}\n`, "utf8");
		} catch {
			// Logging must never break command execution.
		}
	}
}
