import type { LucideIcon } from "lucide-react";
import { FileSpreadsheet, FileText, MonitorCog, Presentation } from "lucide-react";
import type { DesktopCapabilityId } from "../../../src/shared/types.ts";

/** A single concrete tool the model can call when its capability is enabled. */
export interface ToolEntry {
	/** Raw tool name exposed to the model (matches getActiveDesktopToolNames). */
	name: string;
	/** Friendly Chinese label. */
	title: string;
	/** What the tool does, in plain language. */
	description: string;
	/** Optional grouping shown as a divider inside the capability. */
	group?: string;
}

/** A capability bundles a set of related tools that share one on/off switch. */
export interface ToolsetCapability {
	id: DesktopCapabilityId;
	title: string;
	/** Short role line shown under the title. */
	subtitle: string;
	description: string;
	icon: LucideIcon;
	/** When locked, the 命令优先 switch is fixed on and cannot be toggled. */
	commandFirstLocked: boolean;
	/** Explains what 命令优先 means for this capability. */
	commandFirstNote: string;
	tools: ToolEntry[];
}

export const TOOLSET_CATALOG: ToolsetCapability[] = [
	{
		id: "system",
		title: "系统操作",
		subtitle: "Windows 控制 · 命令 · 键鼠 · 沙箱",
		description:
			"通过后台命令、系统 API、进程启动、窗口控制、键鼠自动化和安全 PowerShell 操作 Windows。优先直接完成操作，必要时才回退到界面点击。",
		icon: MonitorCog,
		commandFirstLocked: true,
		commandFirstNote: "系统操作固定优先使用后台命令 / API，不通过此开关切换。",
		tools: [
			{ name: "find_app", title: "查找应用", description: "按名称或关键词搜索本机已安装的应用，返回可启动的路径或 AppId。", group: "应用与窗口" },
			{ name: "open_app", title: "启动应用", description: "按名称、可执行文件路径、快捷方式或 AppId 启动应用。" },
			{ name: "open_windows_settings", title: "打开系统设置页", description: "直接跳转到声音、显示、蓝牙、网络等 Windows 设置页面。" },
			{ name: "window_control", title: "窗口控制", description: "最小化、最大化、还原、聚焦或关闭指定窗口。" },
			{ name: "keyboard_mouse", title: "键鼠自动化", description: "合成键盘输入、组合键、鼠标移动与点击。" },
			{ name: "media_control", title: "媒体控制", description: "播放 / 暂停、上一首 / 下一首等系统级媒体按键。" },
			{ name: "app_interaction", title: "应用界面交互", description: "读取并操作前台应用的 UI 元素，完成点击、填表等交互。" },
			{ name: "set_audio_device_or_volume", title: "音频设备 / 音量", description: "切换默认输出设备或设置系统音量。", group: "系统设置" },
			{ name: "set_display_brightness_or_scale", title: "屏幕亮度 / 缩放", description: "调整显示器亮度与缩放比例。" },
			{ name: "desktop_observe", title: "桌面观察", description: "截图并描述当前桌面与窗口布局，辅助判断下一步操作。", group: "观察与命令" },
			{ name: "get_screen_context", title: "屏幕上下文", description: "获取当前前台窗口、选区等屏幕上下文信息。" },
			{ name: "shell_command_safe", title: "安全 Shell 命令", description: "在受控环境中执行经过白名单校验的命令。" },
			{ name: "shell_command_continue", title: "继续 Shell 会话", description: "向正在运行的交互式命令发送后续输入。" },
			{ name: "shell_command_abort", title: "终止 Shell 命令", description: "中止当前正在执行的命令。" },
			{ name: "sandbox_status", title: "沙箱状态", description: "查看沙箱是否启用、用量与配额。", group: "沙箱工作区" },
			{ name: "sandbox_init", title: "初始化沙箱", description: "创建或重新挂载沙箱工作区。" },
			{ name: "sandbox_reset", title: "重置沙箱", description: "清空并重建沙箱工作区。" },
			{ name: "sandbox_list", title: "列出沙箱内容", description: "浏览沙箱内的文件与目录。" },
			{ name: "sandbox_clean", title: "清理沙箱", description: "删除沙箱中的临时文件。" },
			{ name: "sandbox_import", title: "导入到沙箱", description: "把真实系统的文件复制进沙箱处理。" },
			{ name: "sandbox_export", title: "从沙箱导出", description: "把沙箱中的成果交付回真实系统。" },
		],
	},
	{
		id: "document",
		title: "文档操作",
		subtitle: "Word 创建 · 编辑 · 排版 · 导出",
		description: "创建、读取、检查、编辑、排版与校验 Word 文档，并支持通过脚本执行复杂的 Word 操作。",
		icon: FileText,
		commandFirstLocked: false,
		commandFirstNote: "开启后优先用文件 / COM 直接处理文档，而不是模拟界面操作。",
		tools: [
			{ name: "doc_create_from_html", title: "从 HTML 创建 Word", description: "把 HTML 内容渲染并生成结构化的 Word 文档。" },
			{ name: "doc_read", title: "读取文档", description: "提取 Word 文档的正文文本。" },
			{ name: "doc_inspect", title: "检查文档结构", description: "解析标题、段落、表格等结构，为编辑做准备。" },
			{ name: "doc_plan_edits", title: "规划编辑", description: "根据需求生成精确的编辑计划。" },
			{ name: "doc_apply_edits", title: "应用编辑", description: "把编辑计划落地到文档。" },
			{ name: "doc_verify", title: "校验文档", description: "确认编辑后的文档符合预期。" },
			{ name: "office_word_run", title: "Word 高级脚本", description: "通过 Office MCP / COM 执行更复杂的 Word 操作。" },
		],
	},
	{
		id: "excel",
		title: "Excel 操作",
		subtitle: "表格读写 · 公式 · 数据整理",
		description: "读取与写入 Excel 工作簿，处理单元格、公式与数据整理，并支持脚本化的高级操作。",
		icon: FileSpreadsheet,
		commandFirstLocked: false,
		commandFirstNote: "开启后优先用文件直接读写工作簿，而不是模拟界面操作。",
		tools: [
			{ name: "excel_read", title: "读取表格", description: "读取工作表的单元格区域与数据。" },
			{ name: "excel_write", title: "写入表格", description: "向单元格写入数值、文本或公式。" },
			{ name: "office_excel_run", title: "Excel 高级脚本", description: "通过 Office MCP 执行更复杂的 Excel 操作。" },
		],
	},
	{
		id: "ppt",
		title: "PPT 操作",
		subtitle: "演示文稿 · 幻灯片 · 讲稿",
		description: "创建与读取 PowerPoint 演示文稿，处理幻灯片与讲稿，并支持脚本化的高级操作。",
		icon: Presentation,
		commandFirstLocked: false,
		commandFirstNote: "开启后优先用文件直接生成演示文稿，而不是模拟界面操作。",
		tools: [
			{ name: "ppt_create", title: "创建演示文稿", description: "按内容生成 PowerPoint 幻灯片。" },
			{ name: "ppt_read", title: "读取演示文稿", description: "提取幻灯片的文本与结构。" },
			{ name: "office_ppt_run", title: "PPT 高级脚本", description: "通过 Office MCP 执行更复杂的 PowerPoint 操作。" },
		],
	},
];
