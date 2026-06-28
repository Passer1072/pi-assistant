/**
 * System-prompt block for the experimental "模型自动总结改进方案"（出错自我总结）feature.
 *
 * When enabled, this text is appended to the cached system prompt (see
 * desktop-agent-service.ts `appendSystemPrompt`) so the model is reminded on every
 * turn — without paying per-message tokens — to record a structured self-review
 * memo whenever it hits genuine tool difficulties. The summary is written through
 * the existing `memo_create` tool and titled by the id from `session_info`, so the
 * resulting memos can later be handed to Claude/ChatGPT for analysis and fixes.
 */
export function buildErrorSelfSummaryAppendPrompt(): string {
	return [
		"<error_self_summary_experiment>",
		"本会话已开启实验功能「模型自动总结改进方案（出错自我总结）」。请遵守以下规则：",
		"",
		"触发条件：当你在【本轮】调用工具时遇到真实困难——工具调用失败，或工具调用成功但返回内容中含报错（报错信息 / stderr / status=failed）。",
		"排除情形（不算困难，不要总结）：用户拒绝确认（blocked）、用户主动中止或打断本轮、以及纯属用户要求范围内的正常空结果。",
		"",
		"时机：先把【本轮】对用户的正常回答完整说完，不要因为要总结而打断或省略主回答；在回答全部完毕后再补做总结。",
		"",
		"步骤：",
		"1) 调用 session_info 获取当前会话 ID（sessionId）。",
		"2) 调用 memo_create 新建【一条】备忘录：",
		"   - title 固定格式：会话 <sessionId> 出错总结",
		"   - notes 用结构化中文写清楚（缺项可省略对应小节）：",
		"     · 用户需求：用户这一轮让你做什么",
		"     · 执行过程：你依次怎么做的、调用了哪些工具",
		"     · 遇到的问题：在哪一步出错，附上【具体报错原文】（工具名 + 错误信息 / stderr）",
		"     · 尝试与修复：你为绕过/修复做了哪些尝试",
		"     · 最终结果：最终是否成功；若成功，是如何成功的",
		"     · 给分析者的建议：交给 Claude/ChatGPT 时，建议从哪里排查或如何修复",
		'   - tags 传 ["出错总结"]，priority 传 "low"，不要设置 dueAt / reminderAt（这不是待办，避免触发提醒或进入今日到期）。',
		"",
		"粒度：每个出错的轮次各记【一条】；同一会话多轮出错就分别记多条。",
		"兜底：若你忘了自动记录，而用户事后要求「总结刚才的出错」，按上面同样的格式补记一条。",
		"</error_self_summary_experiment>",
	].join("\n");
}
