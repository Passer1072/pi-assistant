import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenWakeWordRuntime } from "../renderer/src/voice/openwakeword-runtime.ts";

const createMock = vi.hoisted(() => vi.fn());

vi.mock("onnxruntime-web", () => ({
	env: {
		wasm: { numThreads: 0 },
		logLevel: "warning",
	},
	InferenceSession: {
		create: createMock,
	},
	Tensor: vi.fn(),
}));

describe("OpenWakeWordRuntime", () => {
	beforeEach(() => {
		createMock.mockReset();
		createMock.mockResolvedValue({
			inputNames: ["input"],
			outputNames: ["output"],
			run: vi.fn(),
		});
		vi.stubGlobal("window", { location: { href: "file:///app/index.html" } });
	});

	it("loads classifier models from bytes", async () => {
		const classifier = new Uint8Array([1, 2, 3, 4]);
		await OpenWakeWordRuntime.load(classifier);

		expect(createMock).toHaveBeenCalledTimes(3);
		const classifierCall = createMock.mock.calls.find((call) => call[0] === classifier);
		expect(classifierCall?.[0]).toBe(classifier);
		expect(classifierCall?.[1]).toEqual({ executionProviders: ["wasm"] });
	});
});
