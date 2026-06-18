import { CONFIG, LABEL_RAPID_PR_SPAM } from "../config";
import type { GitHubEvent, IdentifyFlag } from "../types";
import { isOpenedPR, groupByKey } from "../utils";

export function detectRapidPRSpam(
	events: GitHubEvent[],
	accountAge: number,
): IdentifyFlag[] {
	const flags: IdentifyFlag[] = [];

	// Detects rapid PRs to same repo (fork attack: multiple PRs in quick succession)
	const isEstablished = accountAge >= CONFIG.AGE_ESTABLISHED_ACCOUNT;
	const minRapidPRs = isEstablished
		? CONFIG.RAPID_PR_SPAM_MIN_PRS_ESTABLISHED
		: CONFIG.RAPID_PR_SPAM_MIN_PRS;

	const prEvents = events.filter(isOpenedPR);

	if (prEvents.length < minRapidPRs) {
		return flags;
	}

	const prsByRepo = groupByKey(prEvents, (e) => e.repo?.name);

	let maxConsecutivePairs = 0;
	let maxConsecutiveTimeDiff = 0;
	let spammyRepo = "";

	for (const [repoName, repoPRs] of prsByRepo.entries()) {
		if (repoPRs.length < minRapidPRs) continue;

		let consecutivePairs = 0;
		let maxTimeDiff = 0;

		for (let i = 0; i < repoPRs.length - 1; i++) {
			const timeDiffSeconds = repoPRs[i + 1].time.diff(
				repoPRs[i].time,
				"second",
			);

			if (timeDiffSeconds <= CONFIG.BRANCH_PR_TIME_WINDOW_SECONDS) {
				consecutivePairs++;
				maxTimeDiff = Math.max(maxTimeDiff, timeDiffSeconds);
			}
		}

		if (consecutivePairs > maxConsecutivePairs) {
			maxConsecutivePairs = consecutivePairs;
			maxConsecutiveTimeDiff = maxTimeDiff;
			spammyRepo = repoName;
		}
	}

	// Compare pairs to PR count - 1 (minRapidPRs represents number of PRs, which is pairs + 1)
	if (maxConsecutivePairs >= minRapidPRs - 1) {
		flags.push({
			label: LABEL_RAPID_PR_SPAM,
			points: CONFIG.POINTS_RAPID_PR_SPAM,
			amplifiable: true,
			detail: `${maxConsecutivePairs + 1} PRs opened to ${spammyRepo} within ${maxConsecutiveTimeDiff}s intervals`,
		});
	}

	return flags;
}
