import type React from "react";
import { Check, Globe, Loader2, Trash2 } from "lucide-react";
import type { AiBrowserPreference, BrowserNativeStatus, BrowserTarget, WebSearchProvider } from "../../../../src/shared/types.ts";
import type { SettingsSectionCtx } from "../section-ctx.ts";
import { Reveal, Toggle } from "../section-kit.tsx";

const SEARCH_ENGINE_OPTIONS: { label: string; template: string }[] = [
	{ label: "Google", template: "https://www.google.com/search?q=%s" },
	{ label: "必应 Bing", template: "https://www.bing.com/search?q=%s" },
	{ label: "百度 Baidu", template: "https://www.baidu.com/s?wd=%s" },
	{ label: "DuckDuckGo", template: "https://duckduckgo.com/?q=%s" },
];

function NativeBrowserRow({ icon, label, status }: { icon: React.ReactNode; label: string; status?: BrowserNativeStatus["chrome"] }) {
	return (
		<div className="browser-native-row">
			<span className="setting-label-with-icon">
				{icon}
				<strong>{label}</strong>
			</span>
			<small className={status?.available ? "ok" : "missing"}>
				{status?.available ? (status.aiProfileRunning ? "AI profile 已启动" : "已找到") : "未找到"}
			</small>
		</div>
	);
}

export function BrowserWebSection({ ctx }: { ctx: SettingsSectionCtx }) {
	const { draft, updateDraft, updateDraftBrowser } = ctx;
	const browser = draft.browser;
	const ws = draft.webSearch ?? { mode: "auto" as const, provider: "duckduckgo" as const };
	const wsKeyProvider = ws.provider === "tavily" || ws.provider === "brave" || ws.provider === "bing" || ws.provider === "serper" || ws.provider === "google";

	const wsKeyLabel =
		ws.provider === "tavily" ? "Tavily API Key" : ws.provider === "brave" ? "Brave API Key" : ws.provider === "bing" ? "Bing API Key" : ws.provider === "serper" ? "Serper API Key" : "Google API Key";
	const wsKeyPlaceholder =
		ws.provider === "tavily" ? "tvly-xxxxxxxxxxxxxxxxxxxx" : ws.provider === "brave" ? "BSA-xxxxxxxxxxxxxxxxxxxxxxxx" : ws.provider === "bing" ? "Ocp-Apim-Subscription-Key" : ws.provider === "serper" ? "serper.dev API Key" : "Google Cloud API Key";

	return (
		<>
			<section className="set-section">
				<h3>浏览器</h3>
				<label className="set-row">
					<span className="setting-label-with-icon">
						<Globe size={14} />
						<span>默认浏览器</span>
					</span>
					<select value={browser.defaultBrowser} onChange={(event) => updateDraftBrowser({ defaultBrowser: event.target.value as BrowserTarget })}>
						<option value="built_in">内置浏览器</option>
						<option value="chrome">本机浏览器（Chrome）</option>
						<option value="edge">本机浏览器（Edge）</option>
					</select>
				</label>
				<label className="set-row toggle-row">
					<span>允许 AI 控制浏览器</span>
					<Toggle on={browser.allowAiControl} onToggle={() => updateDraftBrowser({ allowAiControl: !browser.allowAiControl })} label="允许 AI 控制浏览器" />
				</label>
				{browser.allowAiControl ? (
					<Reveal>
						<label className="set-row">
							<span>模型浏览器偏好</span>
							<select value={browser.aiBrowserPreference} onChange={(event) => updateDraftBrowser({ aiBrowserPreference: event.target.value as AiBrowserPreference })}>
								<option value="built_in">内置浏览器</option>
								<option value="external">外置浏览器（Chrome / Edge）</option>
								<option value="auto">自动（由模型决定）</option>
							</select>
						</label>
						<p className="set-hint" style={{ margin: "2px 4px 0" }}>
							内置：只用内置浏览器工具；外置：用外部浏览器扩展 MCP 控制本机 Chrome/Edge（需已启用该 MCP）；自动：两者都给模型自行选择。
						</p>
					</Reveal>
				) : null}
				<label className="set-row">
					<span>内置浏览器首页</span>
					<input type="text" value={browser.homeUrl} onChange={(event) => updateDraftBrowser({ homeUrl: event.target.value })} placeholder="https://www.google.com" />
				</label>
				<label className="set-row">
					<span>默认搜索引擎</span>
					<select
						value={SEARCH_ENGINE_OPTIONS.some((opt) => opt.template === browser.searchTemplate) ? browser.searchTemplate : "custom"}
						onChange={(event) => {
							if (event.target.value !== "custom") updateDraftBrowser({ searchTemplate: event.target.value });
						}}
					>
						{SEARCH_ENGINE_OPTIONS.map((opt) => (
							<option key={opt.template} value={opt.template}>
								{opt.label}
							</option>
						))}
						{SEARCH_ENGINE_OPTIONS.some((opt) => opt.template === browser.searchTemplate) ? null : <option value="custom">自定义</option>}
					</select>
				</label>
				<label className="set-row">
					<span>最大标签页</span>
					<input type="number" min={1} max={32} value={browser.maxTabs} onChange={(event) => updateDraftBrowser({ maxTabs: Number(event.target.value) })} />
				</label>
				<div className="mcp-entry-row">
					<div>
						<strong>内置浏览器</strong>
						<p className="set-hint">使用助手专用持久 profile，保存 Cookie、站点数据、缓存和标签页控制状态。</p>
					</div>
					<button type="button" className="primary-btn" onClick={() => void ctx.openBuiltInBrowser()} disabled={ctx.browserBusy}>
						{ctx.browserBusy ? <Loader2 size={14} className="spin" /> : <Globe size={14} />}
						<span>打开内置浏览器</span>
					</button>
				</div>
				<div className="browser-native-grid">
					<NativeBrowserRow icon={<Globe size={14} />} label="Chrome" status={ctx.nativeBrowserStatus?.chrome} />
					<NativeBrowserRow icon={<Globe size={14} />} label="Edge" status={ctx.nativeBrowserStatus?.edge} />
				</div>
				<div className="browser-clear-row">
					<button
						type="button"
						className="ghost-btn wide"
						disabled={ctx.browserBusy}
						onClick={() => {
							if (window.confirm("确定要清理内置浏览器 Cookie 吗？")) void ctx.clearBuiltInBrowserStorage("cookies");
						}}
					>
						Cookies
					</button>
					<button
						type="button"
						className="ghost-btn wide"
						disabled={ctx.browserBusy}
						onClick={() => {
							if (window.confirm("确定要清理内置浏览器缓存吗？")) void ctx.clearBuiltInBrowserStorage("cache");
						}}
					>
						缓存
					</button>
					<button
						type="button"
						className="ghost-btn wide"
						disabled={ctx.browserBusy}
						onClick={() => {
							if (window.confirm("确定要清理内置浏览器站点数据吗？")) void ctx.clearBuiltInBrowserStorage("site_data");
						}}
					>
						站点数据
					</button>
					<button
						type="button"
						className="danger-btn"
						disabled={ctx.browserBusy}
						onClick={() => {
							if (window.confirm("确定要清理内置浏览器全部存储吗？这会清除登录态和站点数据。")) void ctx.clearBuiltInBrowserStorage("all");
						}}
					>
						<Trash2 size={13} />
						<span>全部清理</span>
					</button>
				</div>
				<p className="set-hint">
					AI 未被用户指定浏览器时会使用默认浏览器；显式说“用 Chrome / Edge / 内置浏览器”只覆盖本次操作，不修改设置。
				</p>
				{ctx.browserStatus ? <div className="skill-editor-status">{ctx.browserStatus}</div> : null}
			</section>

			<section className="set-section">
				<h3>联网搜索</h3>
				<label className="set-row">
					<span>搜索模式</span>
					<select value={ws.mode} onChange={(e) => updateDraft({ webSearch: { ...ws, mode: e.target.value as "off" | "auto" | "on" } })}>
						<option value="off">关闭</option>
						<option value="auto">自动（推荐）</option>
						<option value="on">始终开启</option>
					</select>
				</label>
				<p className="set-hint" style={{ margin: "0 4px 10px" }}>
					<strong>关闭</strong>：禁用联网。<strong>自动</strong>：AI 按需判断是否搜索。<strong>始终开启</strong>：每次对话优先搜索。
				</p>

				{ws.mode !== "off" ? (
					<Reveal>
						<label className="set-row">
							<span>搜索引擎</span>
							<select value={ws.provider ?? "duckduckgo"} onChange={(e) => updateDraft({ webSearch: { ...ws, provider: e.target.value as WebSearchProvider } })}>
								<option value="tavily">Tavily（推荐·1000次/月免费）</option>
								<option value="brave">Brave Search（2000次/月免费）</option>
								<option value="duckduckgo">DuckDuckGo（免费·无需 Key）</option>
								<option value="bing">Bing（Azure，1000次/月免费）</option>
								<option value="google">Google（每日100次免费）</option>
								<option value="serper">Serper.dev（2500次免费额度）</option>
								<option value="searxng">SearXNG（自托管）</option>
							</select>
						</label>

						{wsKeyProvider ? (
							<div className="ws-provider-fields">
								<label className="set-row">
									<span>{wsKeyLabel}</span>
									<div className="key-input-row" style={{ flex: 1, minWidth: 0 }}>
										<input type="password" placeholder={wsKeyPlaceholder} value={ctx.wsApiKey} onChange={(e) => ctx.setWsApiKey(e.target.value)} />
										<button type="button" className="ghost-btn" onClick={ctx.saveWsFields} title="保存">
											<Check size={14} />
										</button>
									</div>
								</label>
								{ws.apiKey && ctx.wsApiKey === ws.apiKey ? (
									<div className="key-status-chip ok" style={{ margin: "0 4px 6px" }}>
										<Check size={12} />
										<span>已配置</span>
									</div>
								) : null}
							</div>
						) : null}

						{ws.provider === "google" ? (
							<div className="ws-provider-fields">
								<label className="set-row">
									<span>搜索引擎 ID（cx）</span>
									<div className="key-input-row" style={{ flex: 1, minWidth: 0 }}>
										<input type="text" placeholder="cx: 017576662512468239146:omuauf_lfve" value={ctx.wsGoogleCx} onChange={(e) => ctx.setWsGoogleCx(e.target.value)} />
										<button type="button" className="ghost-btn" onClick={ctx.saveWsFields} title="保存">
											<Check size={14} />
										</button>
									</div>
								</label>
							</div>
						) : null}

						{ws.provider === "searxng" ? (
							<div className="ws-provider-fields">
								<label className="set-row">
									<span>实例 URL</span>
									<div className="key-input-row" style={{ flex: 1, minWidth: 0 }}>
										<input type="text" placeholder="https://searx.example.com" value={ctx.wsSearxngUrl} onChange={(e) => ctx.setWsSearxngUrl(e.target.value)} />
										<button type="button" className="ghost-btn" onClick={ctx.saveWsFields} title="保存">
											<Check size={14} />
										</button>
									</div>
								</label>
							</div>
						) : null}

						<div className="ws-hint-block">
							{ws.provider === "tavily" ? (
								<p className="set-hint">
									专为 AI Agent 设计，返回内容已提炼，无需额外抓取页面。在{" "}
									<a href="https://app.tavily.com" target="_blank" rel="noopener noreferrer" className="set-link">app.tavily.com</a>{" "}
									注册，免费每月 1000 次。推荐首选。
								</p>
							) : null}
							{ws.provider === "brave" ? (
								<p className="set-hint">
									独立搜索索引，不依赖 Google/Bing，结果质量高。在{" "}
									<a href="https://brave.com/search/api/" target="_blank" rel="noopener noreferrer" className="set-link">brave.com/search/api</a>{" "}
									注册，免费每月 2000 次。
								</p>
							) : null}
							{ws.provider === "duckduckgo" ? (
								<p className="set-hint">免费使用，无需注册。返回即时答案和相关词条，适合事实查询。如需完整网页搜索结果，请切换到其他引擎。</p>
							) : null}
							{ws.provider === "bing" ? (
								<p className="set-hint">
									在{" "}
									<a href="https://portal.azure.com/" target="_blank" rel="noopener noreferrer" className="set-link">Azure 控制台</a>{" "}
									创建「Bing Search v7」资源，免费层每月 1000 次查询。Key 类型：Ocp-Apim-Subscription-Key。
								</p>
							) : null}
							{ws.provider === "google" ? (
								<p className="set-hint">
									需要两样东西：①{" "}
									<a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer" className="set-link">Cloud Console</a>{" "}
									创建 Custom Search JSON API 并获取 API Key；②在{" "}
									<a href="https://programmablesearchengine.google.com/" target="_blank" rel="noopener noreferrer" className="set-link">Programmable Search Engine</a>{" "}
									创建搜索引擎并复制 cx 值。每日免费 100 次。
								</p>
							) : null}
							{ws.provider === "serper" ? (
								<p className="set-hint">
									在{" "}
									<a href="https://serper.dev/" target="_blank" rel="noopener noreferrer" className="set-link">serper.dev</a>{" "}
									注册并获取 API Key。新用户免费 2500 次，返回 Google 搜索结果，速度快质量高。
								</p>
							) : null}
							{ws.provider === "searxng" ? (
								<p className="set-hint">
									填入你自建的 SearXNG 实例地址（需开启 JSON API）。公共实例列表：{" "}
									<a href="https://searx.space/" target="_blank" rel="noopener noreferrer" className="set-link">searx.space</a>。注意：公共实例可能有访问限制。
								</p>
							) : null}
						</div>
					</Reveal>
				) : null}
			</section>
		</>
	);
}
