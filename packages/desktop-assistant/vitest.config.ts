import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const codingAgentSrcIndex = fileURLToPath(new URL("../coding-agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@earendil-works\/pi-coding-agent$/, replacement: codingAgentSrcIndex },
			{ find: /^@earendil-works\/pi-tui$/, replacement: tuiSrcIndex },
		],
	},
	test: {
		environment: "node",
		globals: true,
		testTimeout: 30000,
	},
});
