import { describe, expect, it } from "vitest";
import { VoiceBridge } from "../src/voice/voice-bridge.ts";

describe("VoiceBridge", () => {
	it("emits wake and transcript states", () => {
		const bridge = new VoiceBridge();
		const states: string[] = [];
		bridge.on("wake", (state) => states.push(state.state));
		bridge.on("transcript", (state) => states.push(state.state));

		const wake = bridge.start("Hi PI", "zh-CN");
		const transcript = bridge.update({ visible: true, state: "transcribing", transcript: "打开记事本" });
		const stop = bridge.stop();

		expect(wake.visible).toBe(true);
		expect(wake.state).toBe("wake-listening");
		expect(transcript.transcript).toBe("打开记事本");
		expect(stop.visible).toBe(false);
		expect(states).toEqual(["wake-listening", "transcribing", "idle"]);
	});

	it("can start directly in manual input mode", () => {
		const bridge = new VoiceBridge();
		const wake = bridge.start("Hi PI", "zh-CN", "manual");

		expect(wake.state).toBe("awaiting-speech");
		expect(wake.wakeWord).toBe("Hi PI");
	});
});
