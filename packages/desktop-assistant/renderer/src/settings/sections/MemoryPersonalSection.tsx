import { Brain, Check, Eye, Loader2, Trash2 } from "lucide-react";
import type { SettingsSectionCtx } from "../section-ctx.ts";
import { Reveal, SettingsAccordion, Toggle } from "../section-kit.tsx";

const ROLE_PRESETS = ["资深程序员", "贴心助理", "英语老师", "猫娘", "知心朋友"];
const TONE_PRESETS = ["专业严谨", "友好亲切", "简洁高效", "幽默风趣", "温柔体贴"];

export function MemoryPersonalSection({ ctx }: { ctx: SettingsSectionCtx }) {
	const { draft, updateDraftMemory, updateDraftPersonalization } = ctx;
	const memory = draft.memory;
	const personalization = draft.personalization;
	const home = draft.homeWelcome;

	return (
		<>
			<section className="set-section">
				<h3>跨对话记忆（实验）</h3>
				<label className="set-row toggle-row">
					<span>启用跨对话记忆</span>
					<Toggle on={memory.enabled} onToggle={() => updateDraftMemory({ enabled: !memory.enabled })} label="启用跨对话记忆" />
				</label>
				<p className="set-hint">本地 JSONL 记忆，默认关闭。开启后会在新请求前检索相关记忆并注入模型；当前用户消息始终优先于旧记忆。</p>
				{memory.enabled ? (
					<Reveal>
						<label className="set-row">
							<span>每次最多注入</span>
							<input type="number" min={0} max={20} value={memory.maxInjected} onChange={(event) => updateDraftMemory({ maxInjected: Number(event.target.value) })} />
						</label>
						<label className="set-row toggle-row">
							<span>自动提取记忆</span>
							<Toggle on={memory.autoExtract} onToggle={() => updateDraftMemory({ autoExtract: !memory.autoExtract })} label="自动提取记忆" />
						</label>
						{memory.autoExtract ? (
							<Reveal>
								<label className="set-row toggle-row">
									<span>允许从外部上下文提取</span>
									<Toggle
										on={memory.allowExternalContextExtraction}
										onToggle={() => updateDraftMemory({ allowExternalContextExtraction: !memory.allowExternalContextExtraction })}
										label="允许从外部上下文提取"
									/>
								</label>
								<label className="set-row toggle-row">
									<span>允许保存 AI 推导事实</span>
									<Toggle
										on={memory.allowAssistantDerivedFacts}
										onToggle={() => updateDraftMemory({ allowAssistantDerivedFacts: !memory.allowAssistantDerivedFacts })}
										label="允许保存 AI 推导事实"
									/>
								</label>
							</Reveal>
						) : null}
					</Reveal>
				) : null}
				<div className="history-controls">
					<div className="history-info">
						<span>已保存</span>
						<strong>{ctx.globalMemories.length}</strong>
						<small>条记忆</small>
					</div>
					<button type="button" className="ghost-btn wide" onClick={ctx.openMemoryModal}>
						<Brain size={14} />
						<span>查看 / 清理</span>
					</button>
				</div>
			</section>

			<section className="set-section">
				<h3>个性化</h3>
				<label className="set-row toggle-row">
					<span>启用个性化</span>
					<Toggle on={personalization.enabled} onToggle={() => updateDraftPersonalization({ enabled: !personalization.enabled })} label="启用个性化" />
				</label>
				<p className="set-hint">开启后，下面的称呼、角色、语气与所在地会注入到对话与首页问候，让小派按你的设定回应。改动对新建的对话生效。</p>
				{personalization.enabled ? (
					<Reveal>
						<label className="set-row">
							<span>对你的称呼</span>
							<input
								type="text"
								placeholder="例如：主人 / 老板 / 你的名字"
								value={personalization.userAddressing ?? ""}
								onChange={(e) => updateDraftPersonalization({ userAddressing: e.target.value || undefined })}
							/>
						</label>
						<label className="set-row">
							<span>扮演角色</span>
							<input
								type="text"
								placeholder="例如：资深程序员 / 贴心助理 / 英语老师"
								value={personalization.rolePlay ?? ""}
								onChange={(e) => updateDraftPersonalization({ rolePlay: e.target.value || undefined })}
							/>
						</label>
						<div className="set-chip-row">
							{ROLE_PRESETS.map((role) => (
								<button key={role} type="button" className="set-chip" onClick={() => updateDraftPersonalization({ rolePlay: role })}>
									{role}
								</button>
							))}
						</div>
						<label className="set-row">
							<span>语气</span>
							<input
								type="text"
								placeholder="例如：友好亲切 / 专业严谨"
								value={personalization.tone ?? ""}
								onChange={(e) => updateDraftPersonalization({ tone: e.target.value || undefined })}
							/>
						</label>
						<div className="set-chip-row">
							{TONE_PRESETS.map((tone) => (
								<button key={tone} type="button" className="set-chip" onClick={() => updateDraftPersonalization({ tone })}>
									{tone}
								</button>
							))}
						</div>
						<label className="set-row toggle-row">
							<span>所在地</span>
							<div className="seg-control">
								<button type="button" className={`seg-btn ${personalization.locationMode === "auto" ? "on" : ""}`} onClick={() => updateDraftPersonalization({ locationMode: "auto" })}>
									自动检测
								</button>
								<button type="button" className={`seg-btn ${personalization.locationMode === "manual" ? "on" : ""}`} onClick={() => updateDraftPersonalization({ locationMode: "manual" })}>
									手动设置
								</button>
							</div>
						</label>
						{personalization.locationMode === "manual" ? (
							<label className="set-row">
								<span>城市/地区</span>
								<input
									type="text"
									placeholder="例如：北京市 / 上海 浦东"
									value={personalization.manualLocation ?? ""}
									onChange={(e) => updateDraftPersonalization({ manualLocation: e.target.value || undefined })}
								/>
							</label>
						) : (
							<p className="set-hint" style={{ margin: "2px 4px 0" }}>
								将复用「首页智能问候」的 WeatherAPI 按 IP 自动定位（需在下方配置 WeatherAPI Key）。未配置时所在地会自动略过。
							</p>
						)}
					</Reveal>
				) : null}
			</section>

			<SettingsAccordion title="首页智能问候" subtitle={`AI 动态问候 ${home.enabled ? "开" : "关"} · 天气 / 邮箱概览`}>
				<label className="set-row toggle-row">
					<span>启用 AI 动态问候</span>
					<Toggle on={home.enabled} onToggle={() => ctx.updateDraft({ homeWelcome: { ...home, enabled: !home.enabled } })} label="启用 AI 动态问候" />
				</label>
				<p className="set-hint">
					开启后，首页问候由 DeepSeek Flash 根据日期/时段/节日和你的待办、自动化生成，启动时一次、运行中最多每 30 分钟刷新一次（仅在内容变化时才真正调用模型，省 token）。关闭则显示固定问候。
				</p>
				{home.enabled ? (
					<Reveal>
						<label className="set-row toggle-row">
							<span>结合天气</span>
							<Toggle on={home.includeWeather} onToggle={() => ctx.updateDraft({ homeWelcome: { ...home, includeWeather: !home.includeWeather } })} label="结合天气" />
						</label>
						<label className="set-row toggle-row">
							<span>结合邮箱未读</span>
							<Toggle on={home.includeEmail} onToggle={() => ctx.updateDraft({ homeWelcome: { ...home, includeEmail: !home.includeEmail } })} label="结合邮箱未读" />
						</label>
						<label className="set-row">
							<span>WeatherAPI Key</span>
							<div className="input-with-btn">
								<input type="password" placeholder="请输入 WeatherAPI.com API Key" value={ctx.weatherApiKey} onChange={(e) => ctx.setWeatherApiKey(e.target.value)} />
								<button type="button" className="ghost-btn" onClick={ctx.saveWeatherApiKey} title="保存">
									<Check size={14} />
								</button>
							</div>
						</label>
						{home.weatherApiKey && ctx.weatherApiKey === home.weatherApiKey ? (
							<div className="key-status-chip ok" style={{ margin: "0 4px 6px" }}>
								<Check size={12} />
								<span>已配置</span>
							</div>
						) : null}
						<p className="set-hint">
							在{" "}
							<a href="https://www.weatherapi.com/my/" target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); window.open("https://www.weatherapi.com/my/"); }}>
								weatherapi.com/my
							</a>{" "}
							获取免费 API Key（每月 100 万次免费调用）。填写后首页右上角会显示天气卡片；开启上面「结合天气」还会把天气写进问候语。未填写则两者都略过。
						</p>
					</Reveal>
				) : null}
			</SettingsAccordion>

			<SettingsAccordion title="应用启动记忆" subtitle={`已学习 ${ctx.appCacheAliasCount ?? "?"} 个应用别名`}>
				<div className="history-controls">
					<div className="history-info">
						<span>已学习</span>
						<strong>{ctx.appCacheAliasCount ?? "?"}</strong>
						<small>个应用别名</small>
					</div>
					<div className="cache-controls">
						<button type="button" className="ghost-btn wide" onClick={() => void ctx.openAppCache()} disabled={ctx.appCacheBusy}>
							{ctx.appCacheBusy ? <Loader2 size={14} className="spin" /> : <Eye size={14} />}
							<span>浏览记忆</span>
						</button>
						<button
							type="button"
							className="danger-btn"
							disabled={ctx.appCacheBusy}
							onClick={async () => {
								if (window.confirm("确定要清空 app-launch-cache 记忆吗？之后 AI 会重新学习应用路径。")) await ctx.clearAppCache();
							}}
						>
							<Trash2 size={13} />
							<span>清空记忆</span>
						</button>
					</div>
				</div>
				<p className="set-hint">用于记住 QQ、微信等应用的真实启动路径，避免新对话重复 open_app 失败再 find_app。</p>
				{ctx.appCacheStatus ? <div className="skill-editor-status">{ctx.appCacheStatus}</div> : null}
			</SettingsAccordion>
		</>
	);
}
