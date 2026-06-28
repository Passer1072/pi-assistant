import { BookOpen, ChevronRight, Plug } from "lucide-react";
import type { DesktopAssistantSettings } from "../../../../src/shared/types.ts";
import type { SettingsSectionCtx } from "../section-ctx.ts";

export function CapabilitiesSection({ ctx }: { ctx: SettingsSectionCtx }) {
	const { draft, updateDraft, snapshot } = ctx;
	return (
		<>
			<section className="set-section">
				<h3>扩展能力</h3>
				<div className="mcp-entry-row">
					<div>
						<strong>{draft.mcp.enabled ? "MCP 已启用" : "MCP 已关闭"}</strong>
						<p className="set-hint">管理 MCP 总开关、服务器、工具发现，以及内置 Desktop Assistant MCP 示例。</p>
					</div>
					<button type="button" className="primary-btn" onClick={ctx.onOpenMcp}>
						<ChevronRight size={14} />
						<span>MCP 管理</span>
					</button>
				</div>
				<div className="mcp-entry-row">
					<div>
						<strong>插件管理</strong>
						<p className="set-hint">安装、验证、测试和删除仅通过 API 控制的软件插件。</p>
					</div>
					<button type="button" className="primary-btn" onClick={ctx.onOpenPlugins}>
						<Plug size={14} />
						<span>插件管理</span>
					</button>
				</div>
				<div className="mcp-entry-row">
					<div>
						<strong>个人定制 Skill</strong>
						<p className="set-hint">保存个人流程、交接文档和任务经验。AI 只能维护这里，不能维护系统自带 skill。</p>
					</div>
					<button type="button" className="primary-btn" onClick={ctx.onOpenPersonalSkills}>
						<BookOpen size={14} />
						<span>个人 Skill 仓库</span>
					</button>
				</div>
			</section>

			<section className="set-section">
				<h3>安全</h3>
				<label className="set-row">
					<span>权限模式</span>
					<select
						value={draft.permissionMode}
						onChange={(event) => updateDraft({ permissionMode: event.target.value as DesktopAssistantSettings["permissionMode"] })}
					>
						<option value="full_access">完全控制</option>
						<option value="automatic">替我审批</option>
						<option value="tiered">请求批准</option>
						<option value="sandbox">仅沙盒</option>
					</select>
				</label>
				<p className="set-hint">
					沙箱内的安全操作始终免审批；下列模式只决定「跨到真实系统」的动作如何处理：完全控制=模型优先用沙箱、必须用真实系统时自动放行；替我审批=模型裁决，拿不准的升级给你；请求批准=所有真实系统动作都要你批准；仅沙盒=禁止一切真实系统动作。
				</p>
				<label className="set-row">
					<span>沙箱工作区</span>
					<button type="button" className="ghost-btn wide" onClick={() => window.desktopAssistant.openSandboxSettingsWindow()}>
						打开沙箱设置…
					</button>
				</label>
				{snapshot.sandboxStatus ? (
					<p className="set-hint">
						当前{snapshot.settings.sandbox.enabled ? "已启用" : "已关闭"} · 用量 {snapshot.sandboxStatus.usageMb}MB / {snapshot.sandboxStatus.quotaMb}MB
					</p>
				) : null}
				<p className="set-hint">
					沙箱把文档处理、临时文件、试探性命令等中间工作隔离在工作区内完成，只把最终成果交付真实系统。完整配置（开关 / 预设 / 根目录 / 命令 / 网络 / 资源上限 / 状态）在独立窗口里。
				</p>
			</section>
		</>
	);
}
