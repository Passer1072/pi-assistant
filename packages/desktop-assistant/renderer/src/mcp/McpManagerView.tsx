import type React from "react";
import { ArrowLeft, Check, Loader2, Minus, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { DesktopAssistantSnapshot, McpServerConfig, McpServerListResponse } from "../../../src/shared/types.ts";

export interface McpServerDraft {
	id?: string;
	name: string;
	enabled: boolean;
	transport: "stdio" | "http";
	command: string;
	argsText: string;
	envText: string;
	cwd: string;
	timeoutMs: number;
	toolNamePrefix: string;
	description: string;
	builtIn?: boolean;
}

export const emptyMcpDraft: McpServerDraft = {
	name: "",
	enabled: true,
	transport: "stdio",
	command: "",
	argsText: "",
	envText: "",
	cwd: "",
	timeoutMs: 10000,
	toolNamePrefix: "",
	description: "",
};
export function McpManagerView({
	snapshot,
	onBack,
	onSnapshot,
	windowed = false,
}: {
	snapshot: DesktopAssistantSnapshot;
	onBack: () => void;
	onSnapshot: (snapshot: DesktopAssistantSnapshot) => void;
	windowed?: boolean;
}) {
	const [list, setList] = useState<McpServerListResponse | undefined>();
	const [selectedId, setSelectedId] = useState<string | undefined>();
	const [draft, setDraft] = useState<McpServerDraft>(emptyMcpDraft);
	const [busy, setBusy] = useState(false);
	const [statusText, setStatusText] = useState("");

	const loadMcp = async () => {
		if (!window.desktopAssistant) return;
		const next = await window.desktopAssistant.listMcpServers();
		setList(next);
		if (!selectedId && next.servers[0]) {
			selectServer(next.servers[0], next);
		}
	};

	useEffect(() => {
		void loadMcp();
	}, []);

	useEffect(() => {
		return window.desktopAssistant?.onEvent((event) => {
			if (event.mcp) setList(event.mcp);
			if (event.snapshot) onSnapshot(event.snapshot);
		});
	}, [onSnapshot]);

	const currentList = list ?? {
		enabled: snapshot.settings.mcp.enabled,
		servers: snapshot.settings.mcp.servers,
		statuses: [],
	};
	const selectedStatus = currentList.statuses.find((status) => status.id === selectedId);

	const selectServer = (server: McpServerConfig, fromList = currentList) => {
		setSelectedId(server.id);
		setDraft(serverToDraft(server));
		const status = fromList.statuses.find((item) => item.id === server.id);
		setStatusText(status?.lastError ?? "");
	};

	const setEnabled = async (enabled: boolean) => {
		if (!window.desktopAssistant) return;
		setBusy(true);
		setStatusText("");
		try {
			const next = await window.desktopAssistant.setMcpEnabled({ enabled });
			setList(next);
			const latestSnapshot = await window.desktopAssistant.getSnapshot();
			onSnapshot(latestSnapshot);
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const saveServer = async () => {
		if (!window.desktopAssistant || !draft.name.trim()) return;
		setBusy(true);
		setStatusText("");
		try {
			const next = await window.desktopAssistant.upsertMcpServer({ server: draftToServer(draft) });
			setList(next);
			const saved = next.servers.find((server) => server.id === draft.id) ?? next.servers.at(-1);
			if (saved) selectServer(saved, next);
			const latestSnapshot = await window.desktopAssistant.getSnapshot();
			onSnapshot(latestSnapshot);
			setStatusText("MCP server saved.");
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const deleteServer = async () => {
		if (!window.desktopAssistant || !draft.id || draft.builtIn) return;
		setBusy(true);
		setStatusText("");
		try {
			const next = await window.desktopAssistant.deleteMcpServer({ id: draft.id });
			setList(next);
			const first = next.servers[0];
			if (first) selectServer(first, next);
			const latestSnapshot = await window.desktopAssistant.getSnapshot();
			onSnapshot(latestSnapshot);
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const testServer = async () => {
		if (!window.desktopAssistant || !currentList.enabled) return;
		setBusy(true);
		setStatusText("");
		try {
			const status = await window.desktopAssistant.testMcpServer(
				draft.id ? { id: draft.id } : { server: draftToServer(draft) },
			);
			setStatusText(status.state === "connected" ? `Connected. Tools: ${status.toolCount}` : status.lastError ?? status.state);
			await loadMcp();
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const refreshServer = async () => {
		if (!window.desktopAssistant || !currentList.enabled || !draft.id) return;
		setBusy(true);
		setStatusText("");
		try {
			const next = await window.desktopAssistant.refreshMcpServer({ id: draft.id });
			setList(next);
			setStatusText("Capabilities refreshed.");
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className={`screen settings-screen mcp-manager-screen ${windowed ? "windowed" : ""}`}>
			<div className="titlebar" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
				<button
					className="title-btn"
					onClick={onBack}
					type="button"
					aria-label={windowed ? "关闭 MCP 管理" : "返回设置"}
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					{windowed ? <X size={16} /> : <ArrowLeft size={16} />}
				</button>
				<div className="title-label">MCP 管理 / MCP Manager</div>
				<div className="title-window-controls" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
					<button className="title-btn" onClick={() => window.desktopAssistant?.minimizeWindow?.()} type="button" aria-label="最小化">
						<Minus size={14} />
					</button>
					<button className="title-btn danger" onClick={() => window.desktopAssistant?.closeWindow?.()} type="button" aria-label="关闭">
						<X size={14} />
					</button>
				</div>
			</div>
			<div className="settings-scroll mcp-manager-scroll">
				<section className="set-section">
					<div className="mcp-header-row">
						<div>
							<h3>MCP 总开关 / Master Switch</h3>
							<p className="set-hint">
								开启后暴露 MCP tools；关闭后断开连接、停止 stdio 子进程，并移除 MCP tools。
							</p>
						</div>
						<button
							type="button"
							className={`toggle ${currentList.enabled ? "on" : ""}`}
							onClick={() => void setEnabled(!currentList.enabled)}
							aria-pressed={currentList.enabled}
							disabled={busy}
						>
							<span className="toggle-thumb" />
						</button>
					</div>
				</section>

				<div className="mcp-layout">
					<section className="set-section mcp-server-list">
						<div className="mcp-section-title">
							<h3>服务器 / Servers</h3>
							<button
								type="button"
								className="ghost-btn wide"
								onClick={() => {
									setSelectedId(undefined);
									setDraft(emptyMcpDraft);
									setStatusText("");
								}}
							>
								<Plus size={14} />
								<span>新增 / Add</span>
							</button>
						</div>
						{currentList.servers.map((server) => {
							const status = currentList.statuses.find((item) => item.id === server.id);
							return (
								<button
									type="button"
									key={server.id}
									className={`mcp-server-item ${server.id === selectedId ? "active" : ""}`}
									onClick={() => selectServer(server)}
								>
									<div>
										<strong>{server.name}</strong>
										<small>{server.builtIn ? "Built-in" : server.transport}</small>
									</div>
									<span className={`mcp-state ${status?.state ?? "disconnected"}`}>
										{status?.state ?? "disconnected"}
									</span>
									<small>{status?.toolCount ?? 0} tools</small>
								</button>
							);
						})}
					</section>

					<section className="set-section mcp-editor">
						<div className="mcp-section-title">
							<h3>{draft.id ? "编辑服务器 / Edit" : "新增服务器 / Add"}</h3>
							{draft.builtIn ? <span className="mcp-badge">内置 / Built-in</span> : null}
						</div>
						<label className="set-row toggle-row">
							<span>启用 / Enabled</span>
							<button
								type="button"
								className={`toggle ${draft.enabled ? "on" : ""}`}
								onClick={() => setDraft((current) => ({ ...current, enabled: !current.enabled }))}
								aria-pressed={draft.enabled}
							>
								<span className="toggle-thumb" />
							</button>
						</label>
						<label className="set-row">
							<span>名称 / Name</span>
							<input
								type="text"
								value={draft.name}
								disabled={draft.builtIn}
								onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
							/>
						</label>
						<label className="set-row">
							<span>传输 / Transport</span>
							<select
								value={draft.transport}
								disabled={draft.builtIn}
								onChange={(event) =>
									setDraft((current) => ({ ...current, transport: event.target.value as "stdio" | "http" }))
								}
							>
								<option value="stdio">stdio</option>
								<option value="http">http reserved</option>
							</select>
						</label>
						<label className="set-row">
							<span>命令 / Command</span>
							<input
								type="text"
								placeholder="node / python / uvx / npx"
								value={draft.command}
								disabled={draft.builtIn}
								onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))}
							/>
						</label>
						<label className="set-row mcp-textarea-row">
							<span>参数 / Args</span>
							<textarea
								value={draft.argsText}
								disabled={draft.builtIn}
								placeholder={"one argument per line\nC:/path/to/server.js"}
								onChange={(event) => setDraft((current) => ({ ...current, argsText: event.target.value }))}
							/>
						</label>
						<label className="set-row mcp-textarea-row">
							<span>环境变量 / Env</span>
							<textarea
								value={draft.envText}
								disabled={draft.builtIn}
								placeholder={"KEY=value\nTOKEN=[redacted] keeps existing value"}
								onChange={(event) => setDraft((current) => ({ ...current, envText: event.target.value }))}
							/>
						</label>
						<label className="set-row">
							<span>CWD</span>
							<input
								type="text"
								value={draft.cwd}
								disabled={draft.builtIn}
								onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))}
							/>
						</label>
						<label className="set-row">
							<span>前缀 / Prefix</span>
							<input
								type="text"
								value={draft.toolNamePrefix}
								onChange={(event) => setDraft((current) => ({ ...current, toolNamePrefix: event.target.value }))}
							/>
						</label>
						<label className="set-row">
							<span>超时 / Timeout</span>
							<input
								type="number"
								min={1000}
								max={120000}
								step={500}
								value={draft.timeoutMs}
								onChange={(event) => setDraft((current) => ({ ...current, timeoutMs: Number(event.target.value || 10000) }))}
							/>
						</label>
						<label className="set-row mcp-textarea-row">
							<span>说明 / Description</span>
							<textarea
								value={draft.description}
								onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
							/>
						</label>
						<div className="mcp-editor-actions">
							<button type="button" className="primary-btn" onClick={saveServer} disabled={busy || !draft.name.trim()}>
								{busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
								<span>保存 / Save</span>
							</button>
							<button type="button" className="ghost-btn wide" onClick={testServer} disabled={busy || !currentList.enabled}>
								<RefreshCw size={14} />
								<span>测试 / Test</span>
							</button>
							<button type="button" className="ghost-btn wide" onClick={refreshServer} disabled={busy || !currentList.enabled || !draft.id}>
								<RefreshCw size={14} />
								<span>刷新 / Refresh</span>
							</button>
							<button type="button" className="danger-btn" onClick={deleteServer} disabled={busy || !draft.id || draft.builtIn}>
								<Trash2 size={13} />
								<span>删除 / Delete</span>
							</button>
						</div>
						{!currentList.enabled ? (
							<p className="set-hint">MCP 总开关关闭时只能离线编辑配置，不能测试连接或刷新能力。</p>
						) : null}
						{statusText ? <div className="skill-editor-status">{statusText}</div> : null}
						{selectedStatus ? (
							<div className="mcp-capability-summary">
								<div>
									<strong>Tools</strong>
									<span>{selectedStatus.toolCount}</span>
								</div>
								<div>
									<strong>Resources</strong>
									<span>{selectedStatus.resourceCount}</span>
								</div>
								<div>
									<strong>Prompts</strong>
									<span>{selectedStatus.promptCount}</span>
								</div>
							</div>
						) : null}
						{selectedStatus?.tools.length ? (
							<div className="mcp-tool-list">
								{selectedStatus.tools.map((tool) => (
									<code key={tool.name}>{tool.name}</code>
								))}
							</div>
						) : null}
					</section>
				</div>
			</div>
		</div>
	);
}

function serverToDraft(server: McpServerConfig): McpServerDraft {
	return {
		id: server.id,
		name: server.name,
		enabled: server.enabled,
		transport: server.transport,
		command: server.command ?? "",
		argsText: (server.args ?? []).join("\n"),
		envText: Object.entries(server.env ?? {})
			.map(([key, value]) => `${key}=${value}`)
			.join("\n"),
		cwd: server.cwd ?? "",
		timeoutMs: server.timeoutMs ?? 10000,
		toolNamePrefix: server.toolNamePrefix ?? "",
		description: server.description ?? "",
		builtIn: server.builtIn,
	};
}

function draftToServer(draft: McpServerDraft): Partial<McpServerConfig> & Pick<McpServerConfig, "name"> {
	return {
		id: draft.id,
		name: draft.name.trim(),
		enabled: draft.enabled,
		transport: draft.transport,
		command: draft.command.trim() || undefined,
		args: splitLines(draft.argsText),
		env: parseEnvText(draft.envText),
		cwd: draft.cwd.trim() || undefined,
		timeoutMs: draft.timeoutMs,
		toolNamePrefix: draft.toolNamePrefix.trim() || undefined,
		description: draft.description.trim() || undefined,
		builtIn: draft.builtIn,
	};
}

function splitLines(text: string): string[] | undefined {
	const lines = text
		.split(/\r?\n/g)
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.length > 0 ? lines : undefined;
}

function parseEnvText(text: string): Record<string, string> | undefined {
	const env: Record<string, string> = {};
	for (const line of text.split(/\r?\n/g)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf("=");
		if (separator <= 0) continue;
		env[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1);
	}
	return Object.keys(env).length > 0 ? env : undefined;
}
