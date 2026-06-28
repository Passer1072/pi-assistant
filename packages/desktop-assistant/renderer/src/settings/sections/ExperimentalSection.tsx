import type { SettingsSectionCtx } from "../section-ctx.ts";
import { Toggle } from "../section-kit.tsx";

export function ExperimentalSection({ ctx }: { ctx: SettingsSectionCtx }) {
	const { draft, updateDraft } = ctx;
	return (
		<section className="set-section">
			<h3>实验性功能</h3>
			<p className="set-hint" style={{ marginTop: 0 }}>
				以下为实验功能，可能不稳定，并会略增 token 消耗。
			</p>
			<label className="set-row toggle-row">
				<span>模型自动总结改进方案（出错自我总结）</span>
				<Toggle
					on={draft.experimental.errorSelfSummary.enabled}
					onToggle={() =>
						updateDraft({
							experimental: {
								...draft.experimental,
								errorSelfSummary: {
									...draft.experimental.errorSelfSummary,
									enabled: !draft.experimental.errorSelfSummary.enabled,
								},
							},
						})
					}
					label="出错自我总结"
				/>
			</label>
			<p className="set-hint">
				开启后，模型在某一轮调用工具遇到报错（工具失败，或工具成功但返回内容含报错）时，会在答完该轮后自动做一次「流程回顾自我总结」，并记成一条标题为「会话
				xxx 出错总结」的备忘录，方便后续交给 Claude/ChatGPT 分析修复。用户拒绝确认或主动中止造成的失败不会被总结。
			</p>
			<label className="set-row toggle-row">
				<span>实时流程化（边规划边执行的流程图浮窗）</span>
				<Toggle
					on={draft.experimental.liveFlow.enabled}
					onToggle={() =>
						updateDraft({
							experimental: {
								...draft.experimental,
								liveFlow: {
									...draft.experimental.liveFlow,
									enabled: !draft.experimental.liveFlow.enabled,
								},
							},
						})
					}
					label="实时流程化"
				/>
			</label>
			<p className="set-hint">
				开启后，普通会话里遇到多步骤、有明确执行步骤的任务时，模型会先设计一张流程图（显示在右下角可拖动、可折叠的浮窗里），再照着流程图逐步执行——每完成一步会自动把「下一步」回传给模型，避免跑偏；中途遇到问题会研究方案并修改流程图后继续。步骤不清晰时模型会先调研清楚再画。对新建/刷新的会话生效。
			</p>
		</section>
	);
}
