import { CONFIG } from "../config";
import type { GitHubEvent, IdentifyFlag } from "../types";
import { isOpenedPR, groupByKey, matchConsecutivePairsInWindow, toTimestamped } from "../utils";

export function detectBranchPRAutomation(
	events: GitHubEvent[],
	accountAge: number,
): IdentifyFlag[] {
	const flags: IdentifyFlag[] = [];

	const isEstablished = accountAge >= CONFIG.AGE_ESTABLISHED_ACCOUNT; // repeated branch→PR correlations detect automated CI/CD workflows
	const branchPRMinPairs = isEstablished
		? CONFIG.BRANCH_PR_PATTERN_MIN_PAIRS_ESTABLISHED
		: CONFIG.BRANCH_PR_PATTERN_MIN_PAIRS;
	const branchPRMinRatio = isEstablished
		? CONFIG.BRANCH_PR_PATTERN_RATIO_MIN_ESTABLISHED
		: CONFIG.BRANCH_PR_PATTERN_RATIO_MIN;

	const branchCreates = events.filter(
		(e) => e.type === "CreateEvent" && e.payload?.ref_type === "branch",
	);
	const prEvents = events.filter(isOpenedPR);

	if (
		branchCreates.length >= branchPRMinPairs &&
		prEvents.length >= branchPRMinPairs
	) {
		const branchPRRatio = branchCreates.length / prEvents.length;

		if (branchPRRatio >= CONFIG.BRANCH_PR_COUNT_RATIO_MIN) {
			const prTimesByRepo = groupByKey(prEvents, (e) => e.repo?.name);
			let matchedPairs = 0;
			let maxObservedTimeDiff = 0;
			const prIdxByRepo = new Map<string, number>();

			const branchTimes = toTimestamped(branchCreates);

			for (const branchEntry of branchTimes) {
				const repoName = branchEntry.event.repo?.name;
				if (!repoName) continue;

				const repoPrTimes = prTimesByRepo.get(repoName);
				if (!repoPrTimes || repoPrTimes.length === 0) continue;

				if (!prIdxByRepo.has(repoName)) {
					prIdxByRepo.set(repoName, 0);
				}

				let prIdx = prIdxByRepo.get(repoName) ?? 0;

				while (
					prIdx < repoPrTimes.length &&
					repoPrTimes[prIdx].time.valueOf() < branchEntry.time.valueOf()
				) {
					prIdx++;
				}

				if (prIdx < repoPrTimes.length) {
					const timeDiffSeconds = repoPrTimes[prIdx].time.diff(
						branchEntry.time,
						"second",
					);

					if (
						timeDiffSeconds >= 0 &&
						timeDiffSeconds <= CONFIG.BRANCH_PR_TIME_WINDOW_SECONDS
					) {
						matchedPairs++;
						maxObservedTimeDiff = Math.max(
							maxObservedTimeDiff,
							timeDiffSeconds,
						);
						prIdx++;
					}
				}

				prIdxByRepo.set(repoName, prIdx);
			}

			if (matchedPairs >= branchPRMinPairs) {
				const automationRatio = matchedPairs / branchCreates.length;

				if (automationRatio >= branchPRMinRatio) {
					flags.push({
						label: "Automated branch/PR workflow",
						points: CONFIG.POINTS_BRANCH_PR_AUTOMATION,
						amplifiable: true,
						detail: `${matchedPairs}/${branchCreates.length} branch creations followed by PRs within ${maxObservedTimeDiff}s`,
					});
				}
			} else {
				const projectNames = new Set<string>();
				for (const branch of branchTimes) {
					const repo = branch.event.repo?.name;
					if (repo) {
						const projectName = repo.split("/")[1];
						if (projectName) projectNames.add(projectName);
					}
				}

				let forkWorkflowMatches = 0;
				let forkMaxTimeDiff = 0;

				for (const projectName of projectNames) {
					const branchesForProject = branchTimes.filter((b) => {
						const repoName = b.event.repo?.name;
						return repoName && repoName.split("/")[1] === projectName;
					});
					const prsForProject = prEvents.filter((p) => {
						const repoName = p.repo?.name;
						return repoName && repoName.split("/")[1] === projectName;
					});

					if (branchesForProject.length > 0 && prsForProject.length > 0) {
						const { matchCount, maxTimeDiff } = matchConsecutivePairsInWindow(branchesForProject.map(b => b.event), prsForProject, CONFIG.BRANCH_PR_TIME_WINDOW_SECONDS);
						forkWorkflowMatches += matchCount;
						forkMaxTimeDiff = Math.max(forkMaxTimeDiff, maxTimeDiff);
					}
				}

				if (forkWorkflowMatches >= branchPRMinPairs) {
					const automationRatio = forkWorkflowMatches / branchCreates.length;
					if (automationRatio >= branchPRMinRatio) {
						flags.push({
							label: "Automated fork/PR workflow",
							points: CONFIG.POINTS_BRANCH_PR_AUTOMATION,
							amplifiable: true,
							detail: `${forkWorkflowMatches}/${branchCreates.length} fork branches followed by upstream PRs within ${forkMaxTimeDiff}s`,
						});
					}
				}
			}
		}
	}

	return flags;
}
