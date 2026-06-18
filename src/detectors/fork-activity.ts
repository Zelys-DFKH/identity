import dayjs from "dayjs";
import minMax from "dayjs/plugin/minMax";
import utc from "dayjs/plugin/utc";
import { CONFIG } from "../config";
import type { GitHubEvent, IdentifyFlag } from "../types";
import { isOpenedPR, sortByDate, filterByType, findMaxEventsInWindow } from "../utils";

dayjs.extend(utc);
dayjs.extend(minMax);

type ForkTier = { window: number; threshold: number; label: string; points: number; detail: (n: number) => string };

const FORK_SPIKE_TIERS: ForkTier[] = [
	{ window: 24, threshold: CONFIG.FORKS_SURGE_EXTREME_HIGH, label: "Extreme fork automation", points: CONFIG.POINTS_FORK_SURGE_EXTREME_HIGH, detail: (n) => `${n} repositories forked in rapid succession (within 24 hours)` },
	{ window: 24, threshold: CONFIG.FORKS_SURGE_SEVERE, label: "Severe fork surge", points: CONFIG.POINTS_FORK_SURGE_SEVERE, detail: (n) => `${n} repositories forked in rapid succession (within 24 hours)` },
	{ window: 24, threshold: CONFIG.FORKS_EXTREME, label: "Fork spike detected", points: CONFIG.POINTS_FORK_SURGE, detail: (n) => `Burst of ${n} fork events in a single 24-hour window` },
	{ window: 24, threshold: CONFIG.FORKS_HIGH, label: "Multiple forks", points: CONFIG.POINTS_MULTIPLE_FORKS, detail: (n) => `${n} repositories forked in a single 24-hour window` },
	{ window: 48, threshold: CONFIG.FORKS_SURGE_48H, label: "Multi-day fork surge", points: CONFIG.POINTS_FORK_SURGE_48H, detail: (n) => `Concentrated burst: ${n} repositories forked over 2 days` },
	{ window: 72, threshold: CONFIG.FORKS_SURGE_72H, label: "Severe multi-day fork surge", points: CONFIG.POINTS_FORK_SURGE_72H, detail: (n) => `Rapid burst: ${n} repositories forked over 72 hours` },
];

export function detectForkActivity(events: GitHubEvent[]): IdentifyFlag[] {
	const flags: IdentifyFlag[] = [];
	const forkEvents = filterByType(events, "ForkEvent");
	if (forkEvents.length < CONFIG.FORKS_HIGH) return flags;

	const forkTimestamps = sortByDate(forkEvents.map((e) => ({ time: dayjs(e.created_at) })))
		.map((item) => item.time);
	const maxByWindow = new Map([
		[24, findMaxEventsInWindow(forkTimestamps, 24)],
		[48, findMaxEventsInWindow(forkTimestamps, 48)],
		[72, findMaxEventsInWindow(forkTimestamps, 72)],
	]);

	const tier = FORK_SPIKE_TIERS.find(({ window, threshold }) => (maxByWindow.get(window) ?? 0) >= threshold);
	const spike: IdentifyFlag | undefined = tier
		? { label: tier.label, points: tier.points, amplifiable: true, detail: tier.detail(maxByWindow.get(tier.window) ?? 0) }
		: undefined;

	if (spike) flags.push(spike);

	if (forkTimestamps.length > 0 && !spike) { // fork rate metric: activity spans 3+ days only if no spike
		const oldestFork = forkTimestamps[0];
		const newestFork = forkTimestamps[forkTimestamps.length - 1];

		if (oldestFork && newestFork) {
			const forkSpanDays = Math.max(1, newestFork.diff(oldestFork, "day"));
			const forksPerDay = forkEvents.length / forkSpanDays;

			if (forksPerDay >= CONFIG.FORKS_PER_DAY_HIGH && forkSpanDays >= 3) {
				flags.push({
					label: "Sustained fork rate",
					points: CONFIG.POINTS_FORKS_PER_DAY_HIGH,
					amplifiable: true,
					detail: `Average of ${forksPerDay.toFixed(1)} forks per day over ${forkSpanDays} days (${forkEvents.length} total)`,
				});
			}
		}
	}

	const forkDays = new Set<string>(); // consecutive forking days; only flag if no spike already caught
	forkEvents.forEach((e) => {
		forkDays.add(dayjs.utc(e.created_at).format("YYYY-MM-DD"));
	});

	if (forkDays.size >= CONFIG.CONSECUTIVE_FORK_DAYS && !spike) {
		const sortedForkDays = sortByDate(Array.from(forkDays)
			.map((d) => ({ time: dayjs(d, "YYYY-MM-DD") })))
			.map((item) => item.time);

		let maxConsecutiveForkDays = 1;
		let currentStreak = 1;

		for (let i = 1; i < sortedForkDays.length; i++) {
			const prev = sortedForkDays[i - 1];
			const curr = sortedForkDays[i];
			if (curr && prev && curr.diff(prev, "day") === 1) {
				currentStreak++;
				maxConsecutiveForkDays = Math.max(maxConsecutiveForkDays, currentStreak);
			} else {
				currentStreak = 1;
			}
		}

		if (maxConsecutiveForkDays >= CONFIG.CONSECUTIVE_FORK_DAYS) {
			flags.push({
				label: "Extended forking pattern",
				points: CONFIG.POINTS_CONSECUTIVE_FORK_DAYS,
				amplifiable: true,
				detail: `Forking activity on ${forkDays.size} days (${maxConsecutiveForkDays} consecutive), ${forkEvents.length} repositories total`,
			});
		}
	}

	const forkedRepos = new Set(
		forkEvents.map((e) => e.repo?.name).filter((name) => name !== undefined),
	);

	if (forkedRepos.size >= CONFIG.FORK_REPO_DIVERSITY_HIGH && !spike) {
		let timeSpanDetail = "";
		if (forkTimestamps.length > 1) {
			const spanDays = forkTimestamps[forkTimestamps.length - 1].diff(forkTimestamps[0], "day");
			timeSpanDetail = spanDays > 0 ? ` over ${spanDays} days` : " in a short timeframe";
		}
		flags.push({
			label: "Fork scatter pattern",
			points: CONFIG.POINTS_FORK_DIVERSITY,
			amplifiable: true,
			detail: `Targeting ${forkedRepos.size} different repositories${timeSpanDetail}`,
		});
	}

	return flags;
}

export function detectForkCombinedActivity(
	events: GitHubEvent[],
): IdentifyFlag[] {
	const flags: IdentifyFlag[] = [];
	const forkEvents = filterByType(events, "ForkEvent");
	if (forkEvents.length < 12 || events.length < CONFIG.MIN_EVENTS_FOR_ANALYSIS) return flags;

	const forkedRepoNames = new Set(
		forkEvents.map((e) => e.repo?.name).filter((name) => name !== undefined),
	);

	const branchesInForkedRepos = events
		.filter((e) => e.type === "CreateEvent" && e.payload?.ref_type === "branch" &&
			forkedRepoNames.has(e.repo?.name || ""));
	const prsInForkedRepos = events
		.filter((e) => isOpenedPR(e) && forkedRepoNames.has(e.repo?.name || ""));

	if (branchesInForkedRepos.length >= 6 && prsInForkedRepos.length >= 8) {
		const forkTimestamps = forkEvents.map((e) => dayjs(e.created_at));
		const branchTimestamps = branchesInForkedRepos.map((e) => dayjs(e.created_at));
		const prTimestamps = prsInForkedRepos.map((e) => dayjs(e.created_at));

		const latestFork = dayjs.max(forkTimestamps);
		const earliestBranch = dayjs.min(branchTimestamps);
		const earliestPR = dayjs.min(prTimestamps);

		const isChainingEvident = // relaxed ratio check (2.0x tolerance) for incomplete event history
			latestFork &&
			earliestBranch &&
			earliestPR &&
			latestFork.isBefore(earliestBranch) &&
			earliestBranch.isBefore(earliestPR) &&
			prsInForkedRepos.length <= branchesInForkedRepos.length * 2.0;

		if (isChainingEvident) {
			const totalOps = forkEvents.length + branchesInForkedRepos.length + prsInForkedRepos.length;
			flags.push({
				label: "Suspicious chained automations",
				points: CONFIG.POINTS_FORK_COMBINED_ACTIVITY,
				amplifiable: true,
				detail: `${totalOps} chained repository operations: ${forkEvents.length} forks followed by ${branchesInForkedRepos.length} branches, then ${prsInForkedRepos.length} pull requests (based on available event history)`,
			});
		}
	}

	return flags;
}
