// Parses and resolves `/cat ...` slash commands into a config change, an
// imperative nudge, and a toast message. Pure (no DOM, no side effects) so the
// whole command surface is unit-testable; App.tsx applies the result.

import { getPet, listPets } from "./registry.ts";
import type { NudgeAction, PetConfig, PetDefinition, SpriteSkin } from "./types.ts";
import "./pets/cat.ts"; // ensure species are registered when commands run
import "./pets/fox.ts";

export interface CatCommandResult {
	nextConfig?: PetConfig;
	nudge?: NudgeAction;
	feedback: string;
	tone: "completed" | "error";
}

export const CAT_COMMAND_PREFIX = "/cat";

/** True when the raw input is a `/cat` command and should not reach the agent. */
export function isCatCommand(input: string): boolean {
	const trimmed = input.trim().toLowerCase();
	return trimmed === CAT_COMMAND_PREFIX || trimmed.startsWith(`${CAT_COMMAND_PREFIX} `);
}

const COLOR_SYNONYMS: Record<string, string> = {
	白: "white", 白色: "white", white: "white",
	橘: "orange", 橘色: "orange", 橙: "orange", 橙色: "orange", 姜黄: "orange", orange: "orange",
	彩虹: "rainbow", 七彩: "rainbow", rainbow: "rainbow",
};

const SPECIES_SYNONYMS: Record<string, string> = {
	cat: "cat", 猫: "cat", 猫咪: "cat",
	fox: "fox", 狐: "fox", 狐狸: "fox",
};

function resolveSkin(def: PetDefinition, arg: string): SpriteSkin | undefined {
	const lower = arg.toLowerCase();
	const byId = def.skins.find((s) => s.id === lower);
	if (byId) return byId;
	const byLabel = def.skins.find((s) => s.label === arg);
	if (byLabel) return byLabel;
	const id = COLOR_SYNONYMS[arg] ?? COLOR_SYNONYMS[lower];
	return id ? def.skins.find((s) => s.id === id) : undefined;
}

function skinList(def: PetDefinition): string {
	return def.skins.map((s) => `${s.label}(${s.id})`).join("、");
}

function speciesList(): string {
	return listPets().map((p) => `${p.label}(${p.id})`).join("、");
}

function helpText(): string {
	return [
		"🐾 /cat 指令：",
		"on/off 开关 · color <颜色> 换色 · switch <宠物> 换宠物",
		"list 列出可选 · sleep/play/come/speak 逗一逗 · help 帮助",
	].join("\n");
}

export function runCatCommand(input: string, config: PetConfig): CatCommandResult {
	const tokens = input.trim().split(/\s+/);
	const sub = (tokens[1] ?? "").toLowerCase();
	const arg = tokens[2] ?? "";
	const def = getPet(config.speciesId) ?? getPet("cat");
	if (!def) return { feedback: "未找到任何宠物定义。", tone: "error" };

	switch (sub) {
		case "":
		case "help":
			return { feedback: helpText(), tone: "completed" };

		case "on":
			return { nextConfig: { ...config, enabled: true }, feedback: `🐾 ${def.label}已开启。`, tone: "completed" };

		case "off":
			return { nextConfig: { ...config, enabled: false }, feedback: "🐾 宠物已收起（/cat on 唤回）。", tone: "completed" };

		case "color":
		case "颜色": {
			if (!arg) return { feedback: `请指定颜色：${skinList(def)}`, tone: "error" };
			const skin = resolveSkin(def, arg);
			if (!skin) return { feedback: `没有「${arg}」这种颜色。可选：${skinList(def)}`, tone: "error" };
			return { nextConfig: { ...config, enabled: true, colorId: skin.id }, feedback: `🎨 已切换为${skin.label}。`, tone: "completed" };
		}

		case "switch":
		case "pet":
		case "宠物": {
			if (!arg) return { feedback: `请指定宠物：${speciesList()}`, tone: "error" };
			const id = SPECIES_SYNONYMS[arg] ?? SPECIES_SYNONYMS[arg.toLowerCase()] ?? arg.toLowerCase();
			const target = getPet(id);
			if (!target) return { feedback: `还没有「${arg}」这种宠物。可选：${speciesList()}`, tone: "error" };
			return { nextConfig: { ...config, enabled: true, speciesId: target.id }, feedback: `🐾 已切换为${target.label}。`, tone: "completed" };
		}

		case "list":
			return { feedback: `宠物：${speciesList()}\n${def.label}颜色：${skinList(def)}`, tone: "completed" };

		case "sleep":
		case "睡觉":
			return { nudge: "sleep", feedback: "😴 让它去睡觉了。", tone: "completed" };
		case "play":
		case "玩":
			return { nudge: "play", feedback: "🎾 来玩耍啦！", tone: "completed" };
		case "come":
		case "过来":
			return { nudge: "come", feedback: "🐾 跑过来了。", tone: "completed" };
		case "speak":
		case "wake":
		case "醒":
			return { nudge: "wake", feedback: "🐾 戳了戳它。", tone: "completed" };

		default:
			return { feedback: `未知指令「${sub}」。\n${helpText()}`, tone: "error" };
	}
}
