import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { CONFIG, LABEL_ISSUE_BURST, LABEL_STAR_BURST, LABEL_STAR_FARM } from "../config";
import type { GitHubEvent, IdentifyFlag, IdentifyProfile } from "../types";
import { calculateNormalizedShannonsEntropy, findDensestBurst, isExternalEvent, filterByType } from "../utils";

dayjs.extend(utc);

export function detectStarConcentration(events: GitHubEvent[]): IdentifyFlag[] {
	const flags: IdentifyFlag[] = [];
	if (events.length === 0) return flags;

	const watchEvents = filterByType(events, "WatchEvent");
	const pushAndPRCount = events.filter(
		(e) => e.type === "PushEvent" || e.type === "PullRequestEvent",
	).length;

	const watchRatio = watchEvents.length / events.length;
	if (
		watchRatio >= CONFIG.WATCH_CONCENTRATION_RATIO &&
		pushAndPRCount <= CONFIG.WATCH_CONCENTRATION_PUSH_PR_MAX
	) {
		flags.push({
			label: LABEL_STAR_FARM,
			points: CONFIG.POINTS_STAR_CONCENTRATION,
			amplifiable: true,
			detail: `${Math.round(watchRatio * 100)}% of activity is starring with ≤${CONFIG.WATCH_CONCENTRATION_PUSH_PR_MAX} push/PR events`,
		});
	}

	// Sliding window: max watches in any 24-hour span
	const windowMs = 24 * 60 * 60 * 1000;
	const watchTs = watchEvents
		.map((e) => e.created_at)
		.filter((t): t is string => !!t)
		.map((t) => dayjs.utc(t).valueOf())
		.sort((a, b) => a - b);

	let left = 0;
	let maxInWindow = 0;
	for (let right = 0; right < watchTs.length; right++) {
		while (watchTs[right] - watchTs[left] > windowMs) left++;
		const count = right - left + 1;
		if (count > maxInWindow) maxInWindow = count;
	}

	if (maxInWindow >= CONFIG.WATCH_CONCENTRATION_BURST_MIN) {
		flags.push({
			label: LABEL_STAR_BURST,
			points: CONFIG.POINTS_STAR_CONCENTRATION_BURST,
			amplifiable: true,
			detail: `${maxInWindow} stars in a 24-hour window`,
		});
	}

	return flags;
}

export function detectEventMonoculture(events: GitHubEvent[]): IdentifyFlag[] {
	const flags: IdentifyFlag[] = [];
	if (events.length < CONFIG.MONOCULTURE_MIN_EVENTS) return flags;

	const typeCounts = new Map<string, number>();
	for (const e of events) {
		if (e.type) typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
	}

	// Single-type interaction accounts must not be skipped (detectNarrowActivityFocus exempts them)
	const INTERACTION_TYPES = new Set([
		"IssueCommentEvent",
		"PullRequestReviewEvent",
		"PullRequestReviewCommentEvent",
	]);
	// size===0 → undefined → "" → not in INTERACTION_TYPES, so return early
	if (typeCounts.size <= 1 && !INTERACTION_TYPES.has([...typeCounts.keys()][0] ?? ""))
		return flags;

	const counts = Array.from(typeCounts.values());
	const entropy = calculateNormalizedShannonsEntropy(counts);

	if (entropy <= CONFIG.MONOCULTURE_MAX_ENTROPY) {
		const [dominantType, dominantCount] = [...typeCounts.entries()].sort(
			(a, b) => b[1] - a[1],
		)[0];
		const pct = Math.round((dominantCount / events.length) * 100);
		flags.push({
			label: "Event type monoculture",
			points: CONFIG.POINTS_MONOCULTURE,
			amplifiable: true,
			detail: `${dominantType} dominates at ${pct}% of activity (entropy: ${entropy.toFixed(2)})`,
		});
	}

	return flags;
}

export function detectThinProfileBot(
	profile: IdentifyProfile | undefined,
	reposCount: number,
): IdentifyFlag[] {
	const flags: IdentifyFlag[] = [];
	if (!profile) return flags;

	let indicators = 0;
	if (profile.followers <= CONFIG.THIN_PROFILE_FOLLOWERS_MAX) indicators++;
	if (reposCount <= CONFIG.THIN_PROFILE_REPOS_MAX) indicators++;
	if (!profile.name) indicators++;
	if (!profile.bio) indicators++;
	if (!profile.company) indicators++;
	if (!profile.location) indicators++;
	if (!profile.blog) indicators++;

	if (indicators >= CONFIG.THIN_PROFILE_INDICATORS_MIN) {
		flags.push({
			label: "Thin profile",
			points: CONFIG.POINTS_THIN_PROFILE_BOT,
			detail: `${indicators}/7 thin profile indicators`,
			eventBased: false,
		});
	}

	return flags;
}

export function detectIssueBurst(
	events: GitHubEvent[],
	accountName: string,
): IdentifyFlag[] {
	const flags: IdentifyFlag[] = [];

	const issueOpenEvents = events.filter((e) =>
		e.type === "IssuesEvent" && e.payload?.action === "opened" && isExternalEvent(e, accountName),
	);

	if (issueOpenEvents.length < CONFIG.ISSUE_BURST_COUNT_MIN) return flags;

	// Drive-by pattern: issues with no external code contribution.
	// Own-repo pushes don't count — someone can push to their own repos
	// while still spamming issues across many external repos.
	const hasExternalPush = events.some((e) => e.type === "PushEvent" && isExternalEvent(e, accountName));
	if (hasExternalPush) return flags;

	const burst = findDensestBurst(
		issueOpenEvents,
		(e) => e.repo?.name,
		CONFIG.ISSUE_BURST_WINDOW_HOURS * 60,
	);

	if (burst.maxKeyCount >= CONFIG.ISSUE_BURST_REPOS_MIN) {
		flags.push({
			label: LABEL_ISSUE_BURST,
			points: CONFIG.POINTS_ISSUE_BURST,
			amplifiable: true,
			detail: `Issues opened across ${burst.maxKeyCount} repositories within ${CONFIG.ISSUE_BURST_WINDOW_HOURS}h with no code contributions`,
		});
	}

	return flags;
}

export function detectConsumerNoReciprocity(
	events: GitHubEvent[],
	accountName: string,
): IdentifyFlag[] {
	const flags: IdentifyFlag[] = [];

	const consumerCount = events.filter((e) => e.type === "WatchEvent" || e.type === "ForkEvent").length;

	if (consumerCount < CONFIG.CONSUMER_ONLY_EXTERNAL_MIN) return flags;

	const CONTRIBUTION_TYPES = new Set([
		"PushEvent",
		"PullRequestEvent",
		"PullRequestReviewEvent",
		"PullRequestReviewCommentEvent",
	]);
	const hasExternalContribution = events.some((e) =>
		CONTRIBUTION_TYPES.has(e.type ?? "") && isExternalEvent(e, accountName),
	);

	if (!hasExternalContribution) {
		flags.push({
			label: "Consumer with no reciprocity",
			points: CONFIG.POINTS_CONSUMER_NO_RECIPROCITY,
			detail: `${consumerCount} star/fork events with no external push or PR contributions`,
		});
	}

	return flags;
}
