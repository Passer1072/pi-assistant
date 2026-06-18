/// <reference lib="webworker" />

import { OpenWakeWordRuntime } from "./openwakeword-runtime.ts";

type WorkerRequest =
	| {
			type: "load";
			classifier: string | Uint8Array;
			baseHref: string;
	  }
	| {
			type: "score";
			window: Float32Array;
	  }
	| {
			type: "stop";
	  };

type WorkerResponse =
	| { type: "loaded" }
	| { type: "score"; score: number }
	| { type: "error"; message: string };

const ctx = self as DedicatedWorkerGlobalScope;
let runtime: OpenWakeWordRuntime | undefined;

function post(message: WorkerResponse): void {
	ctx.postMessage(message);
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
	void handleMessage(event.data);
};

async function handleMessage(message: WorkerRequest): Promise<void> {
	try {
		if (message.type === "load") {
			runtime = await OpenWakeWordRuntime.load(message.classifier, message.baseHref);
			post({ type: "loaded" });
			return;
		}
		if (message.type === "score") {
			if (!runtime) return;
			post({ type: "score", score: await runtime.score(message.window) });
			return;
		}
		if (message.type === "stop") {
			runtime = undefined;
		}
	} catch (error) {
		post({ type: "error", message: error instanceof Error ? error.message : String(error) });
	}
}
