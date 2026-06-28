/**
 * Best-effort weather glance for the home welcome. Uses WeatherAPI.com (requires
 * a user-configured API key; auto-locates by the requester's IP) and returns a
 * single compact string like "北京 多云 28°C".
 * Never throws — any failure resolves to undefined so the welcome simply omits weather.
 * This is plain HTTP and does NOT go through the language model.
 *
 * Caching/TTL is the caller's job (the service holds a ~2h cache) so a static home
 * screen never re-hits the network.
 */

import type { HomeWeatherView } from "../shared/types.ts";

const WEATHER_TIMEOUT_MS = 4000;

const WEATHER_URL = (apiKey: string) =>
	`https://api.weatherapi.com/v1/current.json?key=${encodeURIComponent(apiKey)}&q=auto:ip&lang=zh`;

/**
 * Structured current weather for the home widget. One network request feeds both
 * the visual card and the AI greeting glance (derive the latter via formatWeatherGlance).
 * Never throws — any failure resolves to undefined.
 */
export async function fetchWeatherSnapshot(apiKey: string, signal?: AbortSignal): Promise<HomeWeatherView | undefined> {
	if (!apiKey) return undefined;
	try {
		const response = await fetch(WEATHER_URL(apiKey), {
			signal: signal ?? AbortSignal.timeout(WEATHER_TIMEOUT_MS),
		});
		if (!response.ok) return undefined;
		const payload = (await response.json()) as unknown;
		return parseWeatherSnapshot(payload);
	} catch {
		return undefined;
	}
}

export async function fetchWeatherGlance(apiKey: string, signal?: AbortSignal): Promise<string | undefined> {
	return formatWeatherGlance(await fetchWeatherSnapshot(apiKey, signal));
}

/** Parse a WeatherAPI.com current.json payload into a structured view. Exported for tests. */
export function parseWeatherSnapshot(payload: unknown): HomeWeatherView | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const p = payload as Record<string, unknown>;

	const location =
		typeof p.location === "object" && p.location !== null ? (p.location as Record<string, unknown>) : undefined;
	const city = location ? readString(location.name) : undefined;

	const current =
		typeof p.current === "object" && p.current !== null ? (p.current as Record<string, unknown>) : undefined;
	if (!current) return undefined;

	const tempC = readNumber(current.temp_c);
	if (tempC === undefined) return undefined;

	const condition =
		typeof current.condition === "object" && current.condition !== null
			? (current.condition as Record<string, unknown>)
			: undefined;

	return {
		city,
		tempC,
		feelsLikeC: readNumber(current.feelslike_c),
		conditionText: condition ? readString(condition.text) : undefined,
		conditionCode: condition ? readNumber(condition.code) : undefined,
		isDay: readNumber(current.is_day) !== 0,
		humidity: readNumber(current.humidity),
		windKph: readNumber(current.wind_kph),
		fetchedAt: new Date().toISOString(),
	};
}

/** Derive a compact "城市 天况 温度" string from a structured snapshot. Exported for tests. */
export function formatWeatherGlance(snapshot: HomeWeatherView | undefined): string | undefined {
	if (!snapshot) return undefined;
	const parts: string[] = [];
	if (snapshot.city) parts.push(snapshot.city);
	if (snapshot.conditionText) parts.push(snapshot.conditionText);
	parts.push(`${Math.round(snapshot.tempC)}°C`);
	return parts.join(" ");
}

function readString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function readNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return undefined;
}
