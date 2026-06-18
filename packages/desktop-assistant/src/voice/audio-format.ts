export const VOICE_SAMPLE_RATE = 16000;

export function encodeWav(samples: Float32Array, sampleRate = VOICE_SAMPLE_RATE): ArrayBuffer {
	const bytesPerSample = 2;
	const dataSize = samples.length * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);
	writeString(view, 0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	writeString(view, 8, "WAVE");
	writeString(view, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * bytesPerSample, true);
	view.setUint16(32, bytesPerSample, true);
	view.setUint16(34, 16, true);
	writeString(view, 36, "data");
	view.setUint32(40, dataSize, true);
	let offset = 44;
	for (const sample of samples) {
		const clamped = Math.max(-1, Math.min(1, sample));
		view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
		offset += bytesPerSample;
	}
	return buffer;
}

export function concatFloat32(chunks: Float32Array[]): Float32Array {
	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const result = new Float32Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

export function resampleTo16k(samples: Float32Array, sourceSampleRate: number): Float32Array {
	if (sourceSampleRate === VOICE_SAMPLE_RATE) return samples;
	const ratio = sourceSampleRate / VOICE_SAMPLE_RATE;
	const targetLength = Math.floor(samples.length / ratio);
	const result = new Float32Array(targetLength);
	for (let index = 0; index < targetLength; index += 1) {
		const sourceIndex = index * ratio;
		const left = Math.floor(sourceIndex);
		const right = Math.min(samples.length - 1, left + 1);
		const mix = sourceIndex - left;
		result[index] = (samples[left] ?? 0) * (1 - mix) + (samples[right] ?? 0) * mix;
	}
	return result;
}

function writeString(view: DataView, offset: number, value: string): void {
	for (let index = 0; index < value.length; index += 1) {
		view.setUint8(offset + index, value.charCodeAt(index));
	}
}
