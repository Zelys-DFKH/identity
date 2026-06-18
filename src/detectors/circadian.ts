import { CONFIG } from "../config";
import type { GitHubEvent, IdentifyFlag } from "../types";

function buildHourHistogram(events: GitHubEvent[]): number[] {
	const hist = new Array<number>(24).fill(0);
	for (const e of events) {
		if (!e.created_at) continue;
		const h = new Date(e.created_at).getUTCHours();
		if (!Number.isNaN(h)) hist[h]++;
	}
	return hist;
}

function longestQuietBlock(hist: number[], threshold: number): number {
	// duplicate array to check wrap-around (e.g. hours 22-2 spanning midnight)
	const doubled = [...hist, ...hist];
	let maxLen = 0;
	let cur = 0;
	for (let i = 0; i < doubled.length; i++) {
		if (doubled[i] <= threshold) {
			cur++;
			if (cur > maxLen) maxLen = cur;
		} else {
			cur = 0;
		}
	}
	return Math.min(maxLen, 24);
}

export function detectCircadianAbsence(events: GitHubEvent[]): IdentifyFlag[] {
	if (events.length < CONFIG.CIRCADIAN_MIN_EVENTS) return [];
	const hist = buildHourHistogram(events);
	const quiet = longestQuietBlock(hist, CONFIG.CIRCADIAN_QUIET_THRESHOLD);
	if (quiet >= CONFIG.CIRCADIAN_QUIET_HOURS) return [];
	return [{
		label: "No circadian rest pattern",
		points: CONFIG.POINTS_CIRCADIAN_ABSENCE,
		amplifiable: true,
		detail: `Longest quiet window is ${quiet}h (need ${CONFIG.CIRCADIAN_QUIET_HOURS}h)`,
	}];
}

export function detectCircadianPresence(events: GitHubEvent[]): IdentifyFlag[] {
	if (events.length < CONFIG.CIRCADIAN_MIN_EVENTS) return [];
	const distinctDays = new Set(
		events.filter((e) => e.created_at).map((e) => new Date(e.created_at!).toISOString().slice(0, 10)),
	).size;
	if (distinctDays < CONFIG.CIRCADIAN_MIN_DAYS) return [];
	const hist = buildHourHistogram(events);
	const activeHours = hist.filter((c) => c > CONFIG.CIRCADIAN_QUIET_THRESHOLD).length;
	if (activeHours < CONFIG.CIRCADIAN_MIN_ACTIVE_HOURS) return [];
	const quiet = longestQuietBlock(hist, CONFIG.CIRCADIAN_QUIET_THRESHOLD);
	if (quiet < CONFIG.CIRCADIAN_PRESENCE_MIN_HOURS) return [];
	return [{
		label: "Diurnal activity pattern",
		points: CONFIG.POINTS_CIRCADIAN_PRESENCE,
		detail: `${quiet}-hour contiguous low-activity window`,
	}];
}
