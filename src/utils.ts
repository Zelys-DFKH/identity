import dayjs from "dayjs";
import type { GitHubEvent } from "./types";

/** Extract repo owner from event, handling optional chaining and null values. */
export function getRepoOwner(e: GitHubEvent | undefined | null): string | undefined {
	return e?.repo?.name?.split("/")[0]?.toLowerCase();
}

/** Check if event is a PR opened action. */
export function isOpenedPR(e: GitHubEvent | undefined | null): boolean {
	return e?.type === "PullRequestEvent" && e?.payload?.action === "opened";
}

/** Check if event is a PR closed action. */
export function isClosedPR(e: GitHubEvent | undefined | null): boolean {
	return e?.type === "PullRequestEvent" && e?.payload?.action === "closed";
}

/** Filter events by type. */
export function filterByType(events: GitHubEvent[], type: string): GitHubEvent[] {
	return events.filter((e) => e.type === type);
}

export function isExternalEvent(e: GitHubEvent | undefined | null, accountName: string): boolean {
	const owner = getRepoOwner(e);
	return !!owner && owner !== accountName.toLowerCase();
}

/** Shannon's entropy: lower=concentrated (bot), higher=distributed. */
function calculateShannonsEntropy(counts: number[]): number {
	if (counts.length === 0) return 0;

	const total = counts.reduce((sum, count) => sum + count, 0);
	if (total === 0) return 0;

	let entropy = 0;
	for (const count of counts) {
		if (count > 0) {
			const probability = count / total;
			entropy -= probability * Math.log2(probability);
		}
	}

	return entropy;
}

/** Normalized Shannon's entropy (0-1): 0=concentrated, 1=uniform. */
export function calculateNormalizedShannonsEntropy(counts: number[]): number {
	if (counts.length <= 1) return 0;

	const entropy = calculateShannonsEntropy(counts);
	const maxEntropy = Math.log2(counts.length);

	return entropy / maxEntropy;
}

// Returns the mean exponential decay weight for a set of events; lower = activity is mostly old.
export function computeActivityRecencyMultiplier(
	events: Array<{ created_at?: string | null }>,
	halfLifeDays: number,
): number {
	if (events.length === 0) return 1;
	if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 1;
	const now = Date.now();
	let total = 0;
	for (const e of events) {
		const t = e.created_at ? new Date(e.created_at).getTime() : NaN;
		if (!e.created_at || Number.isNaN(t)) {
			total += 1;
			continue;
		}
		const ageDays = Math.max(0, msToDays(now - t));
		total += Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
	}
	return total / events.length;
}

/** Sort array of Dayjs dates in ascending order. */
export function sortByDate<T extends { time: ReturnType<typeof dayjs> }>(
	items: T[],
): T[] {
	return items.sort((a, b) => a.time.valueOf() - b.time.valueOf());
}

/** Convert milliseconds to days. */
export function msToDays(ms: number): number {
	return ms / (1000 * 60 * 60 * 24);
}

/** Find max count of events in any window of given hours. */
export function findMaxEventsInWindow(
	timestamps: ReturnType<typeof dayjs>[],
	windowHours: number,
): number {
	if (timestamps.length === 0) return 0;
	let maxEvents = 0, windowStartIdx = 0;
	for (let windowEndIdx = 0; windowEndIdx < timestamps.length; windowEndIdx++) {
		const windowEnd = timestamps[windowEndIdx];
		while (windowEnd && windowEnd.diff(timestamps[windowStartIdx], "hour", true) > windowHours) windowStartIdx++;
		maxEvents = Math.max(maxEvents, windowEndIdx - windowStartIdx + 1);
	}
	return maxEvents;
}

/** Group items by a key function, mapping to arrays of {event, time}. */
export function groupByKey<T extends { created_at?: string | null }>(
	events: T[],
	keyFn: (item: T) => string | undefined,
): Map<string, Array<{ event: T; time: ReturnType<typeof dayjs> }>> {
	const timestamped = events
		.map((e) => ({ event: e, time: dayjs(e.created_at) }))
		.sort((a, b) => a.time.valueOf() - b.time.valueOf());

	const grouped = new Map<string, typeof timestamped>();
	for (const entry of timestamped) {
		const key = keyFn(entry.event);
		if (key) {
			if (!grouped.has(key)) {
				grouped.set(key, []);
			}
			grouped.get(key)?.push(entry);
		}
	}
	return grouped;
}

/** Find the densest burst of events within a time window. Maps timestamps to extracted keys; returns max key count in densest window. */
export function findDensestBurst<T extends { created_at?: string | null }>(
	events: T[],
	extractKey: (item: T) => string | undefined,
	windowMinutes: number,
): { maxKeyCount: number; startIdx: number; endIdx: number } {
	if (events.length === 0) return { maxKeyCount: 0, startIdx: 0, endIdx: 0 };
	const timestamped = events.map((e) => ({ event: e, time: dayjs(e.created_at) }))
		.sort((a, b) => a.time.valueOf() - b.time.valueOf());

	let maxKeyCount = 0, maxStartIdx = 0, maxEndIdx = 0, windowStartIdx = 0;
	for (let windowEndIdx = 0; windowEndIdx < timestamped.length; windowEndIdx++) {
		const windowEnd = timestamped[windowEndIdx]?.time;
		while (timestamped[windowStartIdx] && windowEnd &&
			windowEnd.diff(timestamped[windowStartIdx].time, "minute", true) > windowMinutes) windowStartIdx++;
		const keysInWindow = new Set(
			timestamped.slice(windowStartIdx, windowEndIdx + 1)
				.map((item) => extractKey(item.event))
				.filter((key) => key !== undefined),
		);
		if (keysInWindow.size > maxKeyCount) {
			maxKeyCount = keysInWindow.size;
			maxStartIdx = windowStartIdx;
			maxEndIdx = windowEndIdx;
		}
	}
	return { maxKeyCount, startIdx: maxStartIdx, endIdx: maxEndIdx };
}
