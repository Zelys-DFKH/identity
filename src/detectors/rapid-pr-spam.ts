import { CONFIG, LABEL_RAPID_PR_SPAM } from "../config";
import type { GitHubEvent, IdentifyFlag } from "../types";
import { groupByKey, isOpenedPR, selectByAccountAge } from "../utils";

export function detectRapidPRSpam(
	events: GitHubEvent[],
	accountAge: number,
): IdentifyFlag[] {
	const flags: IdentifyFlag[] = [];

	const minRapidPRs = selectByAccountAge(
		accountAge,
		CONFIG.AGE_ESTABLISHED_ACCOUNT,
		CONFIG.RAPID_PR_SPAM_MIN_PRS_ESTABLISHED,
		CONFIG.RAPID_PR_SPAM_MIN_PRS,
	);

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

		let maxStreak = 0;
		let maxTimeDiff = 0;
		let currentStreak = 1;

		for (let i = 0; i < repoPRs.length - 1; i++) {
			const timeDiffSeconds = repoPRs[i + 1].time.diff(
				repoPRs[i].time,
				"second",
			);

			if (timeDiffSeconds <= CONFIG.BRANCH_PR_TIME_WINDOW_SECONDS) {
				currentStreak++;
				maxStreak = Math.max(maxStreak, currentStreak);
				maxTimeDiff = Math.max(maxTimeDiff, timeDiffSeconds);
			} else {
				currentStreak = 1;
			}
		}

		if (maxStreak > maxConsecutivePairs) {
			maxConsecutivePairs = maxStreak;
			maxConsecutiveTimeDiff = maxTimeDiff;
			spammyRepo = repoName;
		}
	}

	// maxConsecutivePairs now counts actual consecutive PRs in the burst
	if (maxConsecutivePairs >= minRapidPRs) {
		flags.push({
			label: LABEL_RAPID_PR_SPAM,
			points: CONFIG.POINTS_RAPID_PR_SPAM,
			amplifiable: true,
			detail: `${maxConsecutivePairs} PRs opened to ${spammyRepo} within ${maxConsecutiveTimeDiff}s intervals`,
		});
	}

	return flags;
}
