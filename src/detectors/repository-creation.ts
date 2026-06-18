import dayjs from "dayjs";
import { CONFIG } from "../config";
import type { GitHubEvent, IdentifyFlag } from "../types";
import { findMaxEventsInWindow } from "../utils";

export function detectRepositoryCreationBurst(
	events: GitHubEvent[],
): IdentifyFlag[] {
	const flags: IdentifyFlag[] = [];
	if (events.length < CONFIG.MIN_EVENTS_FOR_ANALYSIS) return flags;

	const createEvents = events.filter(
		(e) => e.type === "CreateEvent" && e.payload?.ref_type === "repository",
	);
	if (createEvents.length >= CONFIG.CREATE_EVENTS_MIN) {
		const createTimestamps = createEvents
			.map((e) => dayjs(e.created_at))
			.sort((a, b) => a.valueOf() - b.valueOf());
		const maxCreatesInWindow = findMaxEventsInWindow(createTimestamps, 24);
		const CREATE_BURST_TIERS: [
			threshold: number,
			label: string,
			points: number,
		][] = [
			[
				CONFIG.CREATE_BURST_EXTREME,
				"Concentrated repository creation",
				CONFIG.POINTS_CREATE_BURST_EXTREME,
			],
			[
				CONFIG.CREATE_BURST_HIGH,
				"Frequent repository creation",
				CONFIG.POINTS_CREATE_BURST_HIGH,
			],
		];
		const tier = CREATE_BURST_TIERS.find(([t]) => maxCreatesInWindow >= t);
		if (tier)
			flags.push({
				label: tier[1],
				points: tier[2],
				amplifiable: true,
				detail: `${maxCreatesInWindow} repositories created in a short timeframe (within 24 hours)`,
			});
	}

	return flags;
}
