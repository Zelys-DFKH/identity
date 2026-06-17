import type { GitHubEvent } from "./types";

/** Extract repo owner from event, handling optional chaining and null values. */
export function getRepoOwner(e: GitHubEvent | undefined | null): string | undefined {
	return e?.repo?.name?.split("/")[0]?.toLowerCase();
}

/** Extract repo owner from a repo name string (e.g., "owner/repo" → "owner"). */
export function getRepoOwnerFromName(repoName: string | undefined | null): string | undefined {
	return repoName?.split("/")[0]?.toLowerCase();
}

/** Check if event is a PR opened action. */
export function isOpenedPR(e: GitHubEvent | undefined | null): boolean {
	return e?.type === "PullRequestEvent" && e?.payload?.action === "opened";
}

/** Check if event is a PR closed action. */
export function isClosedPR(e: GitHubEvent | undefined | null): boolean {
	return e?.type === "PullRequestEvent" && e?.payload?.action === "closed";
}

/**
 * Calculate Shannon's entropy of a probability distribution
 * Lower entropy = more concentrated/predictable (bot-like)
 * Higher entropy = more uniformly distributed / random
 */
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

/**
 * Calculate normalized Shannon's entropy (0 to 1)
 * Useful for comparing distributions with different state counts
 * Returns 0-1 where 0 = completely concentrated, 1 = perfectly uniform
 */
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
		const ageDays = Math.max(0, (now - t) / (1000 * 60 * 60 * 24));
		total += Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
	}
	return total / events.length;
}
