import fs from "node:fs";
import path from "node:path";
import type { GitHubEvent, GitHubUser } from "../../src/types";

export function getFixtures(): Array<
	[{ user: GitHubUser; events: GitHubEvent[] }, string]
> {
	const fixturesDir = path.join(__dirname, "../fixtures");

	return fs
		.readdirSync(fixturesDir)
		.filter((file) => file.endsWith(".json"))
		.sort() // Ensure consistent order
		.map((file) => {
			const filePath = path.join(fixturesDir, file);
			const fixture: { user: GitHubUser; events: GitHubEvent[] } = JSON.parse(
				fs.readFileSync(filePath, "utf-8"),
			);
			// Extract classification from filename: automation_*.json -> automation
			const classification = file.split("_")[0] || "unknown";
			// Use the readable login from fixture data: user.login = "johnsmith"
			const username = fixture.user?.login || "unknown";
			return [fixture, `${classification}/${username}`] as const;
		});
}

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
