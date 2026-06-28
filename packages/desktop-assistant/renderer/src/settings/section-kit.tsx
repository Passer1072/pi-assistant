import type React from "react";
import { useState } from "react";
import { Brain, ChevronDown, Cpu, FlaskConical, Globe, type LucideIcon, Mic, Puzzle, Search, SlidersHorizontal } from "lucide-react";

/** Settings category ids, in display order. */
export type SettingsCategoryId = "general" | "model" | "voice" | "web" | "memory" | "caps" | "exp";

export interface SettingsCategory {
	id: SettingsCategoryId;
	label: string;
	icon: LucideIcon;
	/** Search keywords (sub-setting titles) so the search box can find a setting by name. */
	keywords: string;
}

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
	{ id: "general", label: "通用", icon: SlidersHorizontal, keywords: "窗口 置顶 关于 版本 日志 开发者 对话历史 清空" },
	{ id: "model", label: "AI 模型", icon: Cpu, keywords: "模型 提供商 provider deepseek openai anthropic 中转站 relay 官方 api key 密钥 思考强度 工具集 节省 token" },
	{ id: "voice", label: "语音", icon: Mic, keywords: "语音 输入 唤醒词 小派 自定义 灵敏度 唤醒方案 kws openwakeword vosk 模糊阈值 stt 识别 语言 播报 tts 模型" },
	{ id: "web", label: "浏览器与搜索", icon: Globe, keywords: "浏览器 chrome edge 内置 首页 搜索引擎 标签页 ai 控制 偏好 cookies 缓存 联网搜索 tavily brave duckduckgo bing google serper searxng" },
	{ id: "memory", label: "记忆与个性化", icon: Brain, keywords: "跨对话 记忆 注入 自动提取 推导 个性化 称呼 角色 语气 所在地 首页 智能问候 欢迎语 天气 邮箱 应用启动 别名" },
	{ id: "caps", label: "能力与扩展", icon: Puzzle, keywords: "mcp 插件 skill 工具集 权限 沙箱 sandbox" },
	{ id: "exp", label: "实验功能", icon: FlaskConical, keywords: "实验 出错 自我总结 实时 流程化 flow" },
];

/** A controlled on/off toggle styled like the rest of settings. */
export function Toggle({
	on,
	onToggle,
	disabled,
	label,
}: {
	on: boolean;
	onToggle: () => void;
	disabled?: boolean;
	label?: string;
}) {
	return (
		<button
			type="button"
			className={`toggle ${on ? "on" : ""}`}
			onClick={onToggle}
			aria-pressed={on}
			aria-label={label}
			disabled={disabled}
		>
			<span className="toggle-thumb" />
		</button>
	);
}

/** Visual container that groups progressively-disclosed child rows under their parent. */
export function Reveal({ children }: { children: React.ReactNode }) {
	return <div className="set-reveal">{children}</div>;
}

/** Collapsible sub-block inside a section, for secondary/bulky settings. */
export function SettingsAccordion({
	title,
	subtitle,
	defaultOpen = false,
	children,
}: {
	title: string;
	subtitle?: string;
	defaultOpen?: boolean;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<div className={`settings-accordion ${open ? "open" : ""}`}>
			<button type="button" className="settings-accordion-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
				<div className="settings-accordion-text">
					<strong>{title}</strong>
					{subtitle ? <span>{subtitle}</span> : null}
				</div>
				<ChevronDown size={16} className="settings-accordion-chevron" />
			</button>
			{open ? <div className="settings-accordion-body">{children}</div> : null}
		</div>
	);
}

/** Left category navigation + search. Adapts to a horizontal bar in compact mode via CSS. */
export function SettingsNav({
	active,
	onSelect,
	query,
	onQuery,
}: {
	active: SettingsCategoryId;
	onSelect: (id: SettingsCategoryId) => void;
	query: string;
	onQuery: (value: string) => void;
}) {
	const q = query.trim().toLowerCase();
	const filtered = q
		? SETTINGS_CATEGORIES.filter((c) => `${c.label} ${c.keywords}`.toLowerCase().includes(q))
		: SETTINGS_CATEGORIES;
	return (
		<nav className="settings-nav" aria-label="设置分类">
			<div className="settings-search">
				<Search size={14} />
				<input
					type="text"
					value={query}
					onChange={(event) => onQuery(event.target.value)}
					placeholder="搜索设置…"
					aria-label="搜索设置"
				/>
			</div>
			<div className="settings-nav-list">
				{filtered.map((category) => {
					const Icon = category.icon;
					return (
						<button
							key={category.id}
							type="button"
							className={`settings-nav-item ${category.id === active ? "active" : ""}`}
							onClick={() => onSelect(category.id)}
						>
							<Icon size={16} />
							<span>{category.label}</span>
						</button>
					);
				})}
				{filtered.length === 0 ? <p className="settings-nav-empty">无匹配项</p> : null}
			</div>
		</nav>
	);
}
