import type { GitHubEvent, IdentifyProfile } from "../../src/types";

export function makeEvent(
	type: string,
	repoName: string,
	createdAt: string,
	payload?: Record<string, unknown>,
): GitHubEvent {
	return {
		type,
		repo: { name: repoName } as GitHubEvent["repo"],
		created_at: createdAt,
		payload,
	} as GitHubEvent;
}

export function makeMergedPREvent(repoName: string, createdAt: string): GitHubEvent {
	return makeEvent("PullRequestEvent", repoName, createdAt, {
		action: "closed",
		pull_request: { merged: true },
	});
}

export function makeSyncPREvent(repoName: string, createdAt: string): GitHubEvent {
	return makeEvent("PullRequestEvent", repoName, createdAt, {
		action: "synchronize",
	});
}

export function makeProfile(overrides: Partial<IdentifyProfile> = {}): IdentifyProfile {
	return { followers: 0, name: null, bio: null, company: null, location: null, blog: null, ...overrides };
}
