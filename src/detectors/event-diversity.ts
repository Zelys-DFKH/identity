import { CONFIG } from "../config";
import type { GitHubEvent, IdentifyFlag } from "../types";
import { calculateNormalizedShannonsEntropy, isExternalEvent } from "../utils";

export function detectNarrowActivityFocus(
	events: GitHubEvent[],
): IdentifyFlag[] {
	const flags: IdentifyFlag[] = [];

	if (events.length < CONFIG.MIN_EVENTS_FOR_ANALYSIS) {
		return flags;
	}

	// Bots have narrow profiles (low entropy); humans show varied activity (high entropy)
	const eventTypeMap = new Map<string, number>();
	for (const e of events) {
		if (e.type) eventTypeMap.set(e.type, (eventTypeMap.get(e.type) || 0) + 1);
	}

	const eventTypeCount = Array.from(eventTypeMap.values());
	const eventTypeEntropy = calculateNormalizedShannonsEntropy(eventTypeCount);

	const eventTypes = new Set(
		events
			.map((e) => e.type)
			.filter((t): t is string => t !== null && t !== undefined),
	);
	const hasInteraction =
		eventTypes.has("IssueCommentEvent") ||
		eventTypes.has("PullRequestReviewEvent") ||
		eventTypes.has("PullRequestReviewCommentEvent");
	const hasWatches = eventTypes.has("WatchEvent");

	// Pure automation: narrow profile + no interactions, OR high entropy (automated cycling)
	const narrowTypeProfile = eventTypes.size <= 3 && eventTypeEntropy < 0.8;
	const automatedCycling = eventTypeEntropy > 0.85 && eventTypes.size >= 5;

	if (
		(narrowTypeProfile || automatedCycling) &&
		!hasInteraction &&
		!hasWatches
	) {
		flags.push({
			label: "Narrow activity focus",
			points: CONFIG.POINTS_LOW_DIVERSITY,
			amplifiable: true,
			detail: `${eventTypes.size} event types (entropy: ${eventTypeEntropy.toFixed(2)}) without interpersonal interactions`,
		});
	}

	return flags;
}

export function detectPushEventDiversity(
	events: GitHubEvent[],
	accountName: string,
): IdentifyFlag[] {
	const externalOwners = new Set<string>();
	for (const e of events) {
		if (e.type !== "PushEvent" || !isExternalEvent(e, accountName)) continue;
		const name = e.repo?.name;
		if (name) externalOwners.add(name.split("/")[0]);
	}
	if (externalOwners.size < CONFIG.PUSH_DIVERSITY_MIN_OWNERS) return [];
	return [{
		label: "Push diversity",
		points: CONFIG.POINTS_PUSH_DIVERSITY,
		detail: `Pushes to ${externalOwners.size} distinct external repo owners`,
	}];
}

export function detectInteractionDominance(events: GitHubEvent[]): IdentifyFlag[] {
	if (events.length < CONFIG.INTERACTION_MIN_EVENTS) return [];
	const interactionTypes = new Set(["IssueCommentEvent", "PullRequestReviewEvent", "PullRequestReviewCommentEvent"]);
	const interactionEvents = events.filter((e) => e.type && interactionTypes.has(e.type));
	if (interactionEvents.length / events.length < CONFIG.INTERACTION_DOMINANCE_RATIO) return [];
	const distinctRepos = new Set(interactionEvents.map((e) => e.repo?.name).filter(Boolean)).size;
	if (distinctRepos < CONFIG.INTERACTION_MIN_REPOS) return [];
	const pct = Math.round((interactionEvents.length / events.length) * 100);
	return [{
		label: "Interaction-focused contributor",
		points: CONFIG.POINTS_INTERACTION_DOMINANCE,
		detail: `${interactionEvents.length}/${events.length} events (${pct}%) are interactions across ${distinctRepos} repos`,
	}];
}
