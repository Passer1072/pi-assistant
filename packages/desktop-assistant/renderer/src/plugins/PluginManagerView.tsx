import type React from "react";
import {
	Ban,
	Check,
	Circle,
	Cpu,
	Loader2,
	Minus,
	Package,
	Plug,
	RefreshCw,
	ShieldCheck,
	Sparkles,
	Trash2,
	TriangleAlert,
	X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
	ForgeExtensionView,
	McpServerConfig,
	McpServerStatus,
	SoftwarePluginListItem,
	SoftwarePluginListResponse,
	SoftwarePluginOperationProgress,
	SoftwarePluginOperationStep,
	SoftwarePluginTargetValidation,
} from "../../../src/shared/types.ts";

const SECRET_ENV = /(key|token|secret|password|auth|credential)/i;

const PLUGIN_STATUS_LABEL: Record<string, string> = {
	not_installed: "未安装",
	needs_host: "需要宿主",
	installed: "已安装",
	error: "异常",
};

function pluginStatusLabel(status: string | undefined): string {
	return PLUGIN_STATUS_LABEL[status ?? "not_installed"] ?? "未知";
}

const MCP_STATE_LABEL: Record<string, string> = {
	connected: "已连接",
	connecting: "连接中",
	disconnected: "未连接",
	error: "错误",
	disabled: "已禁用",
};

function mcpStateLabel(state: string | undefined): string {
	return MCP_STATE_LABEL[state ?? "disconnected"] ?? state ?? "未知";
}

function hostStatusText(validation: SoftwarePluginTargetValidation): string {
	if (!validation.requiresHost) return "No host plugin is required.";
	if (validation.hostDetected) return validation.hostPath ?? "已检测到宿主";
	if (validation.hostLoaderDetected) return "检测到宿主加载器，但尚未找到插件目录。安装会自动准备插件目录。";
	if (!validation.autoHostInstallSupported) {
		return validation.autoHostInstallBlockReason ?? "当前版本暂不支持自动安装宿主";
	}
	return "安装时会自动下载并写入 BetterNCM/Chromatic 宿主";
}

function stepIcon(step: SoftwarePluginOperationStep) {
	if (step.status === "running") return <Loader2 size={13} className="spin" />;
	if (step.status === "succeeded") return <Check size={13} />;
	if (step.status === "failed") return <TriangleAlert size={13} />;
	if (step.status === "skipped") return <Minus size={13} />;
	return <Circle size={13} />;
}

export function PluginManagerView({ windowed = false }: { windowed?: boolean }) {
	const [list, setList] = useState<SoftwarePluginListResponse | undefined>();
	const [selectedId, setSelectedId] = useState<string | undefined>();
	const [targetPath, setTargetPath] = useState("");
	const [validation, setValidation] = useState<SoftwarePluginTargetValidation | undefined>();
	const [busy, setBusy] = useState(false);
	const [statusText, setStatusText] = useState("");
	const [progress, setProgress] = useState<SoftwarePluginOperationProgress | undefined>();
	const [mcpConfig, setMcpConfig] = useState<McpServerConfig | undefined>();
	const [mcpStatus, setMcpStatus] = useState<McpServerStatus | undefined>();
	const [mcpEnabled, setMcpEnabled] = useState<boolean>(true);
	const [forgeExts, setForgeExts] = useState<ForgeExtensionView[]>([]);

	const selected = list?.plugins.find((item) => item.definition.id === selectedId) ?? list?.plugins[0];
	const visibleProgress = progress?.pluginId === selected?.definition.id ? progress : undefined;
	const mcpServerId = selected?.installed
		? (selected.installed.mcpServerId ?? selected.definition.mcpTemplate.serverId)
		: undefined;
	const forgeAppId = selected?.definition.targetSoftware.id;
	const pluginForgeExts = forgeExts.filter((ext) => ext.appId === forgeAppId);

	const loadMcpInfo = useCallback(async (serverId: string | undefined) => {
		if (!window.desktopAssistant || !serverId) {
			setMcpConfig(undefined);
			setMcpStatus(undefined);
			return;
		}
		try {
			const resp = await window.desktopAssistant.listMcpServers();
			setMcpEnabled(resp.enabled);
			setMcpConfig(resp.servers.find((server) => server.id === serverId));
			setMcpStatus(resp.statuses.find((status) => status.id === serverId));
		} catch {
			// non-fatal: dev-info panel just stays empty
		}
	}, []);

	const loadForge = useCallback(async () => {
		try {
			const resp = await window.desktopAssistant?.listForgeExtensions?.();
			if (resp) setForgeExts(resp.extensions);
		} catch {
			// non-fatal
		}
	}, []);

	const trustForgeTool = async (name: string, trusted: boolean) => {
		if (!window.desktopAssistant || !forgeAppId) return;
		const resp = await window.desktopAssistant.setForgeExtensionTrust({ appId: forgeAppId, name, trusted });
		setForgeExts(resp.extensions);
	};
	const deleteForgeTool = async (name: string) => {
		if (!window.desktopAssistant || !forgeAppId) return;
		const resp = await window.desktopAssistant.deleteForgeExtension({ appId: forgeAppId, name });
		setForgeExts(resp.extensions);
		void loadMcpInfo(mcpServerId);
	};

	useEffect(() => {
		void loadMcpInfo(mcpServerId);
		void loadForge();
	}, [mcpServerId, loadMcpInfo, loadForge]);

	const loadPlugins = async () => {
		if (!window.desktopAssistant) return;
		const next = await window.desktopAssistant.listSoftwarePlugins();
		setList(next);
		const nextSelected = next.plugins.find((item) => item.definition.id === selectedId) ?? next.plugins[0];
		if (nextSelected) {
			setSelectedId(nextSelected.definition.id);
			setTargetPath(
				nextSelected.installed?.targetPath ?? nextSelected.definition.targetSoftware.suggestedPaths[0] ?? "",
			);
		}
	};

	useEffect(() => {
		void loadPlugins();
		void window.desktopAssistant?.getSoftwarePluginProgress?.().then((current) => {
			if (current) setProgress(current);
		});
		return window.desktopAssistant?.onEvent((event) => {
			if (event.type === "software_plugin_progress" && event.softwarePluginProgress) {
				setProgress(event.softwarePluginProgress);
				setBusy(event.softwarePluginProgress.status === "running");
				if (event.softwarePluginProgress.message) {
					setStatusText(event.softwarePluginProgress.message);
				}
			}
		});
	}, []);

	useEffect(() => {
		return window.desktopAssistant?.onEvent((event) => {
			if (event.type === "mcp_status") {
				void loadMcpInfo(mcpServerId);
				void loadForge();
			}
		});
	}, [mcpServerId, loadMcpInfo, loadForge]);

	const selectPlugin = (item: SoftwarePluginListItem) => {
		setSelectedId(item.definition.id);
		setTargetPath(item.installed?.targetPath ?? item.definition.targetSoftware.suggestedPaths[0] ?? "");
		setValidation(undefined);
		setStatusText("");
	};

	const validateTarget = async () => {
		if (!window.desktopAssistant || !selected || !targetPath.trim()) return;
		setBusy(true);
		setStatusText("");
		try {
			const result = await window.desktopAssistant.validateSoftwarePluginTarget({
				pluginId: selected.definition.id,
				targetPath: targetPath.trim(),
			});
			setValidation(result);
			setStatusText(result.valid ? "目标路径验证通过。" : "目标路径验证失败。");
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const installPlugin = async () => {
		if (!window.desktopAssistant || !selected || !targetPath.trim()) return;
		setBusy(true);
		setStatusText("");
		try {
			const result = await window.desktopAssistant.installSoftwarePlugin({
				pluginId: selected.definition.id,
				targetPath: targetPath.trim(),
			});
			setValidation(result.validation);
			setProgress({
				pluginId: selected.definition.id,
				operation: "install",
				status: "succeeded",
				steps: result.steps,
				message: result.message,
			});
			setStatusText(result.message);
			await loadPlugins();
			await loadMcpInfo(result.mcpServer?.id ?? selected.definition.mcpTemplate.serverId);
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const uninstallPlugin = async () => {
		if (!window.desktopAssistant || !selected?.installed) return;
		setBusy(true);
		setStatusText("");
		try {
			const result = await window.desktopAssistant.uninstallSoftwarePlugin({ pluginId: selected.definition.id });
			setValidation(undefined);
			setProgress({
				pluginId: selected.definition.id,
				operation: "uninstall",
				status: "succeeded",
				steps: result.steps,
				message: result.message,
			});
			setStatusText(result.message);
			await loadPlugins();
			setMcpConfig(undefined);
			setMcpStatus(undefined);
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const testBridge = async () => {
		if (!window.desktopAssistant || !selected) return;
		setBusy(true);
		setStatusText("");
		try {
			const result = await window.desktopAssistant.testSoftwarePluginBridge({ pluginId: selected.definition.id });
			setStatusText(result.message);
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className={`screen settings-screen plugin-manager-screen ${windowed ? "windowed" : ""}`}>
			<div className="titlebar" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
				<button
					className="title-btn"
					onClick={() => window.desktopAssistant?.closeWindow?.()}
					type="button"
					aria-label="关闭插件管理"
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					<X size={16} />
				</button>
				<div className="title-label">插件管理</div>
				<div className="title-window-controls" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
					<button className="title-btn" onClick={() => window.desktopAssistant?.minimizeWindow?.()} type="button" aria-label="最小化">
						<Minus size={14} />
					</button>
					<button className="title-btn danger" onClick={() => window.desktopAssistant?.closeWindow?.()} type="button" aria-label="关闭">
						<X size={14} />
					</button>
				</div>
			</div>
			<div className="settings-scroll plugin-manager-scroll">
				<div className="plugin-layout">
					<section className="set-section plugin-catalog">
						<div className="mcp-section-title">
							<h3>插件目录</h3>
							<button type="button" className="ghost-btn wide" onClick={() => void loadPlugins()} disabled={busy}>
								<RefreshCw size={14} />
								<span>刷新</span>
							</button>
						</div>
						{list?.plugins.map((item) => (
							<button
								type="button"
								key={item.definition.id}
								className={`plugin-item ${item.definition.id === selected?.definition.id ? "active" : ""}`}
								onClick={() => selectPlugin(item)}
							>
								<div className="plugin-item-icon">
									<Package size={16} />
								</div>
								<div>
									<strong>{item.definition.name}</strong>
									<small>{item.definition.targetSoftware.name}</small>
								</div>
								<span className={`plugin-state ${item.installed?.status ?? "not_installed"}`}>
									{pluginStatusLabel(item.installed?.status)}
								</span>
							</button>
						))}
					</section>

					<section className="set-section plugin-editor">
						{selected ? (
							<>
								<div className="plugin-detail-head">
									<div>
										<h3>{selected.definition.name}</h3>
										<p className="set-hint">{selected.definition.description}</p>
									</div>
									<span className={`plugin-state ${selected.installed?.status ?? "not_installed"}`}>
										{pluginStatusLabel(selected.installed?.status)}
									</span>
								</div>
								<label className="set-row">
									<span>目标软件路径</span>
									<input
										type="text"
										value={targetPath}
										placeholder={selected.definition.targetSoftware.suggestedPaths[0]}
										onChange={(event) => {
											setTargetPath(event.target.value);
											setValidation(undefined);
											setStatusText("");
										}}
									/>
								</label>
								<p className="set-hint">
									点击安装后会自动安装宿主、写入 bridge 插件并配置 MCP。卸载会移除本插件管理器写入的宿主和插件文件。
								</p>

								<div className="plugin-action-row">
									<button type="button" className="ghost-btn wide" onClick={validateTarget} disabled={busy || !targetPath.trim()}>
										{busy ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />}
										<span>验证路径</span>
									</button>
									<button
										type="button"
										className="primary-btn"
										onClick={installPlugin}
										disabled={busy || !targetPath.trim()}
									>
										<Plug size={14} />
										<span>安装 / 更新</span>
									</button>
									<button type="button" className="ghost-btn wide" onClick={testBridge} disabled={busy || !selected.installed}>
										<RefreshCw size={14} />
										<span>测试桥接</span>
									</button>
									<button type="button" className="danger-btn" onClick={uninstallPlugin} disabled={busy || !selected.installed}>
										<Trash2 size={13} />
										<span>卸载</span>
									</button>
								</div>

								{visibleProgress ? (
									<div className="plugin-operation-card">
										<strong>{visibleProgress.operation === "install" ? "安装流程" : "卸载流程"}</strong>
										<div className="plugin-operation-steps">
											{visibleProgress.steps.map((step) => (
												<div key={step.id} className={`plugin-operation-step ${step.status}`}>
													<div className="plugin-step-icon">{stepIcon(step)}</div>
													<div>
														<strong>{step.title}</strong>
														<span>{step.detail ?? step.description}</span>
													</div>
												</div>
											))}
										</div>
									</div>
								) : null}

								{validation ? (
									<div className="plugin-validation">
										<div className={`key-status-chip ${validation.valid ? "ok" : "warn"}`}>
											{validation.valid ? <Check size={12} /> : <TriangleAlert size={12} />}
											<span>{validation.valid ? "路径有效" : "路径无效"}</span>
										</div>
										<div className="plugin-info-grid">
											<div>
												<strong>插件宿主</strong>
												<span>{hostStatusText(validation)}</span>
											</div>
											<div>
												<strong>软件版本</strong>
												<span>{validation.softwareVersion ?? "未知"}</span>
											</div>
										</div>
										{validation.missingFiles.length ? (
											<div className="plugin-file-list">
												<strong>缺失文件</strong>
												{validation.missingFiles.map((file) => (
													<code key={file}>{file}</code>
												))}
											</div>
										) : null}
										{validation.warnings.map((warning) => (
											<p className="set-hint plugin-warning" key={warning}>
												{warning}
											</p>
										))}
									</div>
								) : null}

								{selected.installed ? (
									<div className="plugin-installed-card">
										<strong>安装记录</strong>
										<code>{selected.installed.targetPath}</code>
										<div className="plugin-info-grid">
											<div>
												<span>桥接地址</span>
												<strong>{selected.installed.bridgeUrl ?? "未配置"}</strong>
											</div>
											<div>
												<span>MCP</span>
												<strong>{selected.installed.mcpServerId ?? selected.definition.mcpTemplate.serverId}</strong>
											</div>
										</div>
										{selected.installed.lastError ? <p className="set-hint plugin-warning">{selected.installed.lastError}</p> : null}
									</div>
								) : null}

								{selected.installed ? (
									<div className="plugin-mcp-card">
										<div className="mcp-section-title">
											<strong className="plugin-mcp-title">
												<Cpu size={14} />
												<span>MCP 能力详情（开发级）</span>
											</strong>
											<button
												type="button"
												className="ghost-btn wide"
												onClick={() => void loadMcpInfo(mcpServerId)}
												disabled={busy}
											>
												<RefreshCw size={14} />
												<span>刷新</span>
											</button>
										</div>
										{!mcpEnabled ? (
											<p className="set-hint plugin-warning">MCP 全局开关已关闭，工具不会激活。请到「MCP 管理」开启后刷新。</p>
										) : null}
										<div className="plugin-info-grid">
											<div>
												<span>运行状态</span>
												<strong className={`mcp-state ${mcpStatus?.state ?? "disconnected"}`}>
													{mcpStateLabel(mcpStatus?.state)}
												</strong>
											</div>
											<div>
												<span>功能数</span>
												<strong>{mcpStatus?.toolCount ?? 0} 个工具</strong>
											</div>
										</div>
										{mcpConfig ? (
											<div className="plugin-file-list">
												<strong>启动配置</strong>
												<code>{`${mcpConfig.command ?? ""} ${(mcpConfig.args ?? []).join(" ")}`.trim()}</code>
												{Object.entries(mcpConfig.env ?? {}).map(([key, value]) => (
													<code key={key}>{`${key}=${SECRET_ENV.test(key) ? "[redacted]" : value}`}</code>
												))}
											</div>
										) : null}
										{mcpStatus?.lastError ? (
											<p className="set-hint plugin-warning">{mcpStatus.lastError}</p>
										) : null}
										<div className="plugin-tool-list">
											<strong>可用功能（工具清单 {mcpStatus?.toolCount ?? 0}）</strong>
											{(mcpStatus?.tools ?? []).length ? (
												mcpStatus?.tools.map((mcpTool) => (
													<div className="plugin-tool" key={mcpTool.name}>
														<code>{mcpTool.name}</code>
														<span>{mcpTool.description ?? mcpTool.title ?? ""}</span>
													</div>
												))
											) : (
												<p className="set-hint">
													未列出工具：请确认 MCP 全局开关已开、目标软件可达（CDP 调试端口），然后点「刷新」。
												</p>
											)}
										</div>

										<div className="plugin-forge-list">
											<strong className="plugin-mcp-title">
												<Sparkles size={13} />
												<span>锻造的工具（AI 自助新增 {pluginForgeExts.length}）</span>
											</strong>
											{pluginForgeExts.length ? (
												pluginForgeExts.map((ext) => (
													<div className={`plugin-forge-tool ${ext.trusted ? "trusted" : "untrusted"}`} key={ext.name}>
														<div className="plugin-forge-head">
															<code>{ext.name}</code>
															<span className={`forge-trust-chip ${ext.trusted ? "ok" : "warn"}`}>
																{ext.trusted ? "已信任" : "未信任（安全门）"}
															</span>
														</div>
														<span className="plugin-forge-desc">{ext.description}</span>
														{ext.notes ? <span className="plugin-forge-notes">逆向依据：{ext.notes}</span> : null}
														<details className="plugin-forge-code">
															<summary>实现代码（开发级）</summary>
															<code>{ext.jsBody}</code>
														</details>
														<div className="plugin-forge-actions">
															{ext.trusted ? (
																<button type="button" className="ghost-btn wide" onClick={() => void trustForgeTool(ext.name, false)}>
																	<Ban size={13} />
																	<span>取消信任</span>
																</button>
															) : (
																<>
																	<button type="button" className="primary-btn" onClick={() => void trustForgeTool(ext.name, true)}>
																		<ShieldCheck size={13} />
																		<span>信任</span>
																	</button>
																	<button type="button" className="ghost-btn wide" onClick={() => void deleteForgeTool(ext.name)}>
																		<Ban size={13} />
																		<span>拒绝</span>
																	</button>
																</>
															)}
															<button type="button" className="danger-btn" onClick={() => void deleteForgeTool(ext.name)}>
																<Trash2 size={13} />
																<span>删除</span>
															</button>
														</div>
													</div>
												))
											) : (
												<p className="set-hint">
													还没有 AI 锻造的工具。当 AI 遇到内置工具做不到的需求时，会逆向并用 forge_register_tool 新增工具，
													新工具默认「未信任」，需在此【信任】后才可使用（信任一次后永久有效）。代码写死的内置工具不会出现在这里、也无法删除。
												</p>
											)}
										</div>
									</div>
								) : null}

								<div className="plugin-steps">
									{selected.definition.installSteps.map((step) => (
										<div key={step.id}>
											<strong>{step.title}</strong>
											<span>{step.description}</span>
										</div>
									))}
								</div>
								{statusText ? <div className="skill-editor-status">{statusText}</div> : null}
							</>
						) : (
							<div className="cache-empty">暂无可用插件。</div>
						)}
					</section>
				</div>
			</div>
		</div>
	);
}
