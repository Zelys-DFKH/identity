import dayjs from "dayjs";
import { CONFIG, LABEL_CLOSED_PR_SPAM_BURST, LABEL_CLOSED_PR_SPAM_SCATTER } from "../config";
import type { GitHubEvent, IdentifyFlag } from "../types";
import { selectByAccountAge } from "../utils";

export function detectClosedPRSpam(
	events: GitHubEvent[],
	accountAge: number,
): IdentifyFlag[] {
	const flags: IdentifyFlag[] = [];

	const minClosedPRs = selectByAccountAge(accountAge, CONFIG.AGE_ESTABLISHED_ACCOUNT, CONFIG.CLOSED_PR_SPAM_MIN_ESTABLISHED, CONFIG.CLOSED_PR_SPAM_MIN);

	const closedPREvents = events.filter((e) => e?.type === "PullRequestEvent" && e?.payload?.action === "closed");

	if (closedPREvents.length < minClosedPRs) {
		return flags;
	}

	// Count distinct repos targeted by closed PRs
	const closedPRRepos = new Set<string>(
		closedPREvents
			.map((e) => e.repo?.name)
			.filter((name) => name !== undefined),
	);

	const closedPRTimestamps = closedPREvents.map((e) => dayjs(e.created_at));
	const earliest = dayjs.min(...closedPRTimestamps);
	const latest = dayjs.max(...closedPRTimestamps);
	const timeSpanMinutes = latest && earliest ? latest.diff(earliest, "minute") : 0;
	const timeSpanDays = latest && earliest ? latest.diff(earliest, "day") : 0;
	const fractionalDays = latest && earliest ? latest.diff(earliest, "day", true) : 0;
	const timeRangeStr =
		timeSpanDays > 0
			? `${timeSpanDays}d`
			: `${Math.ceil(timeSpanMinutes / 60)}h`;

	const prsByDay = new Map<string, number>(); // burst days grouped by day; UTC-normalized for timezone-independent boundaries
	closedPREvents.forEach((e) => {
		const day = dayjs.utc(e.created_at).format("YYYY-MM-DD");
		prsByDay.set(day, (prsByDay.get(day) || 0) + 1);
	});

	const burstDays = Array.from(prsByDay.entries()) // days with >= 10 PRs (significant activity)
		.filter(([_, count]) => count >= 10)
		.sort((a, b) => b[1] - a[1])
		.map(([_, count]) => count);

	let burstStr = ""; // human-readable burst details
	if (burstDays.length > 0) {
		if (burstDays.length === 1) {
			burstStr = `, with a spike of ${burstDays[0]} rejections on one day`;
		} else {
			const burstList =
				burstDays.slice(0, -1).join(", ") +
				` and ${burstDays[burstDays.length - 1]}`;
			burstStr = `, with spike days of ${burstList} rejections each`;
		}
	}

	let points: number = CONFIG.POINTS_CLOSED_PR_SPAM; // severity based on closed PR volume (base: 5-24 PRs)
	if (closedPREvents.length >= 100) {
		points = CONFIG.POINTS_CLOSED_PR_SPAM_EXTREME; // 100+ PRs = extreme spam
	} else if (closedPREvents.length >= 25) {
		points = CONFIG.POINTS_CLOSED_PR_SPAM_HIGH; // 25-99 PRs = high volume spam
	}

	const prDensity = // PR density distinguishes bursts from scattered activity
		fractionalDays > 0.01 ? closedPREvents.length / fractionalDays : closedPREvents.length;
	const hasSignificantBurst = burstDays.length > 0; // at least one day with 10+ rejections
	const enoughPRsForSpread = closedPREvents.length >= 25; // if 25+ PRs, even if scattered, it's suspicious
	const highDensity = prDensity >= 0.5; // at least 1 PR every 2 days or more frequent

	if (
		closedPRRepos.size >= CONFIG.CLOSED_PR_REPO_SPREAD &&
		(hasSignificantBurst || enoughPRsForSpread || highDensity)
	) {
		flags.push({
			label: LABEL_CLOSED_PR_SPAM_SCATTER,
			points,
			amplifiable: true,
			detail: `${closedPREvents.length} PRs were rejected across ${closedPRRepos.size} repositories in ${timeRangeStr}${burstStr}.`,
		});
		return flags;
	}

	// Secondary check: concentrated closing to few repos in short window
	if (closedPRRepos.size >= 2) {
		if (timeSpanMinutes <= CONFIG.CLOSED_PR_TIME_WINDOW_MINUTES) {
			// For burst patterns with extreme volume, boost points even higher
			const burstPoints =
				closedPREvents.length >= 100
					? CONFIG.POINTS_CLOSED_PR_SPAM_BURST_EXTREME
					: points;

			flags.push({
				label: LABEL_CLOSED_PR_SPAM_BURST,
				points: burstPoints,
				amplifiable: true,
				detail: `${closedPREvents.length} PRs closed across ${closedPRRepos.size} repos in ${timeSpanMinutes}m (concentrated rejection/spam activity)`,
			});
		}
	}

	return flags;
}
