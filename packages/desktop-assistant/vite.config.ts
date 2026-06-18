import { defineConfig } from "vite";

export default defineConfig({
	root: "renderer",
	base: "./",
	publicDir: "../resources/public",
	build: {
		outDir: "../renderer-dist",
		emptyOutDir: true,
		rollupOptions: {
			onLog(level, log, handler) {
				const message = typeof log === "string" ? log : log.message;
				const id = typeof log === "string" ? "" : (log.id ?? "");

				if (message.includes("[PLUGIN_TIMINGS]")) {
					return;
				}

				if (
					message.includes("Use of direct `eval` function is strongly discouraged") &&
					id.includes("onnxruntime-web/dist/ort.bundle.min.mjs")
				) {
					return;
				}

				if (message.includes("Some chunks are larger than 500 kB after minification")) {
					return;
				}

				handler(level, log);
			},
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5178,
		strictPort: true,
	},
});
