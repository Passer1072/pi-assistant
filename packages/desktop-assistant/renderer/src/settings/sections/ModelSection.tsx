import { Check, Eye, EyeOff, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { DEFAULT_DEEPSEEK_RELAY_URL } from "../../../../src/shared/deepseek-connection.ts";
import type { DesktopAssistantSettings } from "../../../../src/shared/types.ts";
import { cloneSettings, settingsKey } from "../../settings-draft.ts";
import { PROVIDERS } from "../../settings-view-model.ts";
import type { SettingsSectionCtx } from "../section-ctx.ts";
import { Reveal, SettingsAccordion, Toggle } from "../section-kit.tsx";

export function ModelSection({ ctx }: { ctx: SettingsSectionCtx }) {
	const { draft, updateDraft, snapshot } = ctx;
	const provider = ctx.provider;
	const apiConnectionMode = ctx.apiConnectionMode;
	const relayNeedsKey = provider === "deepseek" && apiConnectionMode === "relay" && ctx.relayModelOptions.length === 0;

	return (
		<>
			<section className="set-section">
				<h3>模型</h3>
				<label className="set-row">
					<span>模型提供商</span>
					<select
						value={provider}
						onChange={(event) => {
							const nextProvider = event.target.value;
							const providerConfig = PROVIDERS.find((item) => item.id === nextProvider);
							updateDraft({
								provider: nextProvider as DesktopAssistantSettings["provider"],
								modelId: providerConfig?.models[0]?.id ?? draft.modelId,
							});
						}}
					>
						{PROVIDERS.map((item) => (
							<option key={item.id} value={item.id}>
								{item.label}
							</option>
						))}
					</select>
				</label>

				{provider === "deepseek" ? (
					<>
						<div className="set-row">
							<span>API 连接方式</span>
							<div className="segmented-control" role="group" aria-label="API 连接方式">
								<button
									type="button"
									className={apiConnectionMode === "official" ? "active" : ""}
									onClick={() => void ctx.switchApiConnectionMode("official")}
									disabled={ctx.settingsApplying}
								>
									官方API
								</button>
								<button
									type="button"
									className={apiConnectionMode === "relay" ? "active" : ""}
									onClick={() => void ctx.switchApiConnectionMode("relay")}
									disabled={ctx.settingsApplying}
								>
									中转站
								</button>
							</div>
						</div>
						{apiConnectionMode === "relay" ? (
							<Reveal>
								<label className="set-row">
									<span>中转站 URL</span>
									<input
										type="text"
										placeholder={DEFAULT_DEEPSEEK_RELAY_URL}
										value={draft.apiBaseUrl ?? DEFAULT_DEEPSEEK_RELAY_URL}
										onChange={(event) => updateDraft({ apiBaseUrl: event.target.value, deepseekRelayModels: undefined })}
									/>
								</label>
								<p className="set-hint" style={{ margin: "2px 4px 0" }}>
									保存中转站 API Key 后会自动探测 /v1/models，并把该 Key 授权的模型放入下方模型列表。
								</p>
							</Reveal>
						) : null}
					</>
				) : null}

				{ctx.isCustom ? (
					<>
						<label className="set-row">
							<span>API Base URL</span>
							<input
								type="text"
								placeholder="https://api.example.com/v1"
								value={draft.apiBaseUrl ?? ""}
								onChange={(event) => updateDraft({ apiBaseUrl: event.target.value })}
							/>
						</label>
						<label className="set-row">
							<span>模型 ID</span>
							<input
								type="text"
								placeholder="gpt-4o / llama3-70b / ..."
								value={draft.modelId}
								onChange={(event) => updateDraft({ modelId: event.target.value })}
							/>
						</label>
					</>
				) : (
					<label className="set-row">
						<span>模型</span>
						<div className="model-select-row">
							<select
								value={draft.modelId}
								disabled={relayNeedsKey}
								onChange={(event) => updateDraft({ modelId: event.target.value })}
							>
								{ctx.displayedModels.map((model) => (
									<option key={model.id} value={model.id}>
										{model.label}
									</option>
								))}
							</select>
							{provider === "deepseek" ? (
								<button
									type="button"
									className="ghost-btn icon-only"
									title="从 API 重新拉取模型列表"
									aria-label="刷新模型列表"
									onClick={ctx.refreshModels}
									disabled={ctx.modelsRefreshing || ctx.settingsApplying}
								>
									{ctx.modelsRefreshing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
								</button>
							) : null}
						</div>
					</label>
				)}
				{relayNeedsKey ? (
					<p className="set-hint">当前还没有探测到中转站授权模型；请先填写 URL 和 API Key 并保存验证。</p>
				) : null}
				{provider === "deepseek" && !ctx.isCustom ? (
					<p className="set-hint">模型列表由 API 拉取（保存 API Key 后自动发现），可点右侧 ↻ 手动刷新。</p>
				) : null}
				{ctx.modelStatus ? <div className="skill-editor-status">{ctx.modelStatus}</div> : null}

				<label className="set-row">
					<span>新会话默认思考强度</span>
					<select
						value={draft.thinkingLevel}
						onChange={(event) => updateDraft({ thinkingLevel: event.target.value as DesktopAssistantSettings["thinkingLevel"] })}
					>
						<option value="off">关闭</option>
						<option value="minimal">极简</option>
						<option value="low">低</option>
						<option value="medium">中</option>
						<option value="high">高</option>
						<option value="xhigh">极高</option>
					</select>
				</label>
				<p className="set-hint">聊天页里的深度思考开关只影响当前会话；这里决定之后新会话的默认值。</p>
			</section>

			<section className="set-section">
				<h3>{ctx.apiKeyLabel}</h3>
				<div className="set-key-block">
					<div className={`key-status-chip ${snapshot.authStatus.configured ? "ok" : "warn"}`}>
						{snapshot.authStatus.configured ? <Check size={12} /> : <KeyRound size={12} />}
						<span>{snapshot.authStatus.configured ? `${ctx.apiKeyLabel} 已配置` : `${ctx.apiKeyLabel} 未配置`}</span>
					</div>
					<div className="key-input-row">
						<input
							type={ctx.showKey ? "text" : "password"}
							placeholder={snapshot.authStatus.configured ? `输入新的${ctx.apiKeyLabel}以替换` : `请输入 ${ctx.apiKeyLabel}`}
							value={ctx.apiKey}
							onChange={(event) => ctx.setApiKey(event.target.value)}
						/>
						<button type="button" className="ghost-btn" onClick={() => ctx.setShowKey((value) => !value)} aria-label={ctx.showKey ? "隐藏" : "显示"}>
							{ctx.showKey ? <EyeOff size={14} /> : <Eye size={14} />}
						</button>
						<button
							type="button"
							className="primary-btn"
							disabled={ctx.saving || ctx.settingsApplying || !ctx.apiKey.trim()}
							onClick={async () => {
								ctx.setSaving(true);
								try {
									if (ctx.hasDraftChanges) {
										const nextSnapshot = await ctx.applyDraft();
										if (!nextSnapshot) return;
									}
									const nextSnapshot = await ctx.onSaveApiKey(ctx.apiKey.trim());
									if (nextSnapshot) {
										ctx.setDraftSettings(cloneSettings(nextSnapshot.settings));
										ctx.setBaselineSettingsKey(settingsKey(nextSnapshot.settings));
									}
									ctx.setApiKey("");
								} finally {
									ctx.setSaving(false);
								}
							}}
						>
							{ctx.saving || snapshot.apiKeyStatus.state === "validating" ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
							<span>保存并验证</span>
						</button>
					</div>
					{ctx.statusText ? <div className={`set-key-status ${snapshot.apiKeyStatus.state}`}>{ctx.statusText}</div> : null}
					<p className="set-hint">
						官方 API Key 和中转站 API Key 会分开保存；切换连接方式并应用后会立即使用对应 Key。保存验证后会从对应端点的 /v1/models 拉取可用模型。当前对话里已经暴露过 Key，建议轮换后再保存。
					</p>
				</div>
			</section>

			<SettingsAccordion title="工具集与节省 Token" subtitle={`${ctx.enabledCapabilityCount}/${ctx.capabilityCount} 组能力 · 节省 Token ${draft.tokenSaving.enabled ? "开" : "关"}`}>
				<div className="mcp-entry-row">
					<div>
						<strong>工具集</strong>
						<p className="set-hint">按能力分组管理 AI 可调用的内置工具（系统操作、文档、Excel、PPT）。</p>
					</div>
					<button type="button" className="primary-btn" onClick={ctx.onOpenToolset}>
						<span>工具集</span>
					</button>
				</div>
				<label className="set-row toggle-row">
					<span>节省 Token</span>
					<Toggle
						on={draft.tokenSaving.enabled}
						onToggle={() => updateDraft({ tokenSaving: { ...draft.tokenSaving, enabled: !draft.tokenSaving.enabled } })}
						label="节省 Token"
					/>
				</label>
				<p className="set-hint">
					开启后只压缩发送给模型的浏览器 MCP 大结果、HTML、长链接列表和旧工具结果；聊天历史和工具详情仍保留原始内容。
				</p>
			</SettingsAccordion>
		</>
	);
}
