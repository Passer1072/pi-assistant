import { Check, Eye, EyeOff, KeyRound, Loader2, Settings2 } from "lucide-react";
import { DEFAULT_VOICE_STT_BASE_URL_BY_PROVIDER, type DesktopAssistantSettings } from "../../../../src/shared/types.ts";
import { resolveWakeWordModelWakeWord } from "../../../../src/shared/wake-word-settings.ts";
import { formatBytes } from "../../formatters.ts";
import { VOICE_PROVIDER_LABEL, VOICE_STT_MODEL_HINT } from "../../settings-view-model.ts";
import type { SettingsSectionCtx } from "../section-ctx.ts";
import { Reveal, SettingsAccordion, Toggle } from "../section-kit.tsx";

export function VoiceSection({ ctx }: { ctx: SettingsSectionCtx }) {
	const { draft, updateDraftVoice, snapshot } = ctx;
	const voice = draft.voice;
	const engine = voice.wakeEngine ?? "kws";
	const isKws = engine === "kws" || engine === "auto";

	return (
		<>
			<section className="set-section">
				<h3>唤醒</h3>
				<label className="set-row toggle-row">
					<span>启用语音输入</span>
					<Toggle on={voice.enabled} onToggle={() => updateDraftVoice({ enabled: !voice.enabled })} label="启用语音输入" />
				</label>
				<label className="set-row toggle-row">
					<span>常驻监听唤醒词</span>
					<Toggle on={voice.wakeWordEnabled} onToggle={() => updateDraftVoice({ wakeWordEnabled: !voice.wakeWordEnabled })} label="常驻监听唤醒词" />
				</label>
				<div className="set-row">
					<span>唤醒方案</span>
					<div className="segmented-control segmented-3" role="group" aria-label="唤醒方案">
						<button type="button" className={isKws ? "active" : ""} onClick={() => void ctx.switchWakeEngine("kws")}>
							本地唤醒
						</button>
						<button
							type="button"
							className={engine === "openwakeword" ? "active" : ""}
							onClick={() => void ctx.switchWakeEngine("openwakeword")}
							disabled={ctx.wakeModelBusy}
						>
							openWakeWord
						</button>
						<button type="button" className={engine === "vosk" ? "active" : ""} onClick={() => void ctx.switchWakeEngine("vosk")}>
							兜底识别
						</button>
					</div>
				</div>

				{isKws ? (
					<Reveal>
						<label className="set-row">
							<span>自定义唤醒词</span>
							<input type="text" value={voice.wakeWord} placeholder="例如：小派" onChange={(event) => updateDraftVoice({ wakeWord: event.target.value })} />
						</label>
						<label className="set-row">
							<span>唤醒灵敏度</span>
							<input
								type="number"
								min={0}
								max={1}
								step={0.05}
								value={voice.kwsSensitivity ?? 0.6}
								onChange={(event) => updateDraftVoice({ kwsSensitivity: Math.max(0, Math.min(1, Number(event.target.value || 0.6))) })}
							/>
						</label>
						<p className="set-hint" style={{ margin: "2px 4px 0" }}>
							本地关键词唤醒（sherpa-onnx，离线）。可填任意中文词，自动转拼音匹配（默认「小派」）；数值越高越容易唤醒。首次使用需运行
							<code> npm run fetch:kws </code>下载模型。
						</p>
					</Reveal>
				) : null}

				{engine === "openwakeword" ? (
					<Reveal>
						<div className="mcp-entry-row">
							<div>
								<strong>{ctx.activeWakeModel ? ctx.activeWakeModel.label : "未选择模型"}</strong>
								<p className="set-hint">
									{ctx.activeWakeModel
										? `${resolveWakeWordModelWakeWord(ctx.activeWakeModel)} · ${formatBytes(ctx.activeWakeModel.sizeBytes)}`
										: "导入 .onnx 后可切换到 openWakeWord"}
								</p>
							</div>
							<button type="button" className="primary-btn" onClick={ctx.openWakeModelModal}>
								<Settings2 size={14} />
								<span>模型管理</span>
							</button>
						</div>
						<label className="set-row">
							<span>激活阈值</span>
							<input
								type="number"
								min={0.05}
								max={1}
								step={0.05}
								value={voice.owwThreshold ?? 0.5}
								onChange={(event) => updateDraftVoice({ owwThreshold: Math.max(0.05, Math.min(1, Number(event.target.value || 0.5))) })}
							/>
						</label>
						<p className="set-hint" style={{ margin: "2px 4px 0" }}>openWakeWord 模式下唤醒词由模型文件名决定，不可手填。</p>
					</Reveal>
				) : null}

				{engine === "vosk" ? (
					<Reveal>
						<label className="set-row">
							<span>自定义唤醒词</span>
							<input type="text" value={voice.wakeWord} placeholder="例如：小派" onChange={(event) => updateDraftVoice({ wakeWord: event.target.value })} />
						</label>
						<label className="set-row">
							<span>模糊阈值</span>
							<input
								type="number"
								min={0.1}
								max={1}
								step={0.05}
								value={voice.fuzzyThreshold}
								onChange={(event) => updateDraftVoice({ fuzzyThreshold: Math.max(0.1, Math.min(1, Number(event.target.value || 0.6))) })}
							/>
						</label>
						<p className="set-hint" style={{ margin: "2px 4px 0" }}>兜底语音识别（Vosk）匹配唤醒词的模糊阈值。</p>
					</Reveal>
				) : null}

				<label className="set-row">
					<span>语音语言</span>
					<select value={voice.language} onChange={(event) => updateDraftVoice({ language: event.target.value })}>
						<option value="zh-CN">中文（普通话）</option>
						<option value="en-US">English (US)</option>
						<option value="ja-JP">日本語</option>
					</select>
				</label>
				{ctx.wakeModelStatus ? <div className="skill-editor-status">{ctx.wakeModelStatus}</div> : null}
			</section>

			<section className="set-section">
				<h3>语音识别</h3>
				<label className="set-row">
					<span>STT Provider</span>
					<select
						value={voice.sttProvider}
						onChange={(event) => updateDraftVoice({ sttProvider: event.target.value as DesktopAssistantSettings["voice"]["sttProvider"] })}
					>
						{Object.entries(VOICE_PROVIDER_LABEL).map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</label>
				<label className="set-row">
					<span>STT Base URL</span>
					<input
						type="text"
						placeholder={DEFAULT_VOICE_STT_BASE_URL_BY_PROVIDER[voice.sttProvider] || "https://example.test/v1"}
						value={voice.sttBaseUrl ?? ""}
						onChange={(event) => updateDraftVoice({ sttBaseUrl: event.target.value || undefined })}
					/>
				</label>
				<label className="set-row">
					<span>STT Model</span>
					<input type="text" value={voice.sttModel} onChange={(event) => updateDraftVoice({ sttModel: event.target.value })} />
				</label>
				<p className="set-hint" style={{ margin: "0 4px 10px" }}>{VOICE_STT_MODEL_HINT}</p>
				<div className="set-key-block voice-key-block">
					<div className={`key-status-chip ${snapshot.voiceAuthStatus.configured ? "ok" : "warn"}`}>
						{snapshot.voiceAuthStatus.configured ? <Check size={12} /> : <KeyRound size={12} />}
						<span>{snapshot.voiceAuthStatus.configured ? "语音 Key 已配置" : "语音 Key 未配置"}</span>
					</div>
					<div className="key-input-row">
						<input type={ctx.showVoiceKey ? "text" : "password"} placeholder="STT API Key" value={ctx.voiceApiKey} onChange={(event) => ctx.setVoiceApiKey(event.target.value)} />
						<button type="button" className="ghost-btn" onClick={() => ctx.setShowVoiceKey((value) => !value)} aria-label={ctx.showVoiceKey ? "隐藏" : "显示"}>
							{ctx.showVoiceKey ? <EyeOff size={14} /> : <Eye size={14} />}
						</button>
						<button
							type="button"
							className="primary-btn"
							disabled={ctx.savingVoiceKey || !ctx.voiceApiKey.trim()}
							onClick={async () => {
								ctx.setSavingVoiceKey(true);
								try {
									await ctx.onSaveVoiceApiKey(ctx.voiceApiKey.trim());
									ctx.setVoiceApiKey("");
								} finally {
									ctx.setSavingVoiceKey(false);
								}
							}}
						>
							{ctx.savingVoiceKey ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
							<span>保存语音 Key</span>
						</button>
					</div>
				</div>
			</section>

			<section className="set-section">
				<h3>语音输出</h3>
				<label className="set-row toggle-row">
					<span>启用语音播报</span>
					<Toggle on={draft.ttsEnabled} onToggle={() => ctx.updateDraft({ ttsEnabled: !draft.ttsEnabled })} label="启用语音播报" />
				</label>
			</section>

			<SettingsAccordion title="高级时序" subtitle="唤醒后等待 · 停顿结束">
				<label className="set-row">
					<span>唤醒后等待（秒）</span>
					<input
						type="number"
						min={1}
						max={30}
						value={Math.round(voice.postWakeWaitMs / 1000)}
						onChange={(event) => updateDraftVoice({ postWakeWaitMs: Math.max(1, Number(event.target.value || 5)) * 1000 })}
					/>
				</label>
				<label className="set-row">
					<span>停顿结束（秒）</span>
					<input
						type="number"
						min={0.3}
						max={5}
						step={0.1}
						value={voice.endSilenceMs / 1000}
						onChange={(event) => updateDraftVoice({ endSilenceMs: Math.max(0.3, Number(event.target.value || 1)) * 1000 })}
					/>
				</label>
			</SettingsAccordion>
		</>
	);
}
