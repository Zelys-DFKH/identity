import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  hasAICommitMetadata,
  analyzeCommitMetadata,
} from "../src/commit-metadata";
import { identify } from "../src/identify";
import type { GitHubCommit } from "../src/types";

const date = new Date(2026, 2, 10, 12);

describe("hasAICommitMetadata", () => {
  it.each<[string, string | undefined | null, boolean]>([
    ["empty undefined", undefined, false],
    ["empty null", null, false],
    ["empty string", "", false],
    ["plain message", "fix: typo in README", false],
    [
      "human co-author",
      "feat: x\n\nCo-authored-by: Alice <alice@example.com>",
      false,
    ],
    [
      "human named Cody",
      "fix\n\nCo-authored-by: Cody Smith <cody@example.com>",
      false,
    ],
    [
      "human named Claude",
      "fix\n\nCo-authored-by: Claude Lemieux <claude@example.com>",
      false,
    ],
    [
      "Claude trailer",
      "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      true,
    ],
    [
      "Claude trailer with model name",
      "fix\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>",
      true,
    ],
    [
      "Claude Code footer (emoji)",
      "chore\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      true,
    ],
    [
      "Claude Code footer (plain)",
      "docs: update\n\nGenerated with Claude Code",
      true,
    ],
    [
      "Copilot github.com email",
      "feat: x\n\nCo-authored-by: GitHub Copilot <copilot@github.com>",
      true,
    ],
    [
      "Copilot users.noreply email",
      "feat: y\n\nCo-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>",
      true,
    ],
    [
      "Cursor agent",
      "feat: z\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>",
      true,
    ],
    [
      "Devin AI integration",
      "wip\n\nCo-authored-by: Devin AI <158243242+devin-ai-integration[bot]@users.noreply.github.com>",
      true,
    ],
    [
      "Codex via openai.com",
      "fix\n\nCo-authored-by: codex <codex@openai.com>",
      true,
    ],
    [
      "openai-codex name",
      "fix\n\nCo-authored-by: openai-codex <foo@bar>",
      true,
    ],
    [
      "Aider",
      "refactor\n\nCo-authored-by: aider (claude-3.5-sonnet)",
      true,
    ],
    [
      "OpenHands agent",
      "feat\n\nCo-authored-by: openhands <openhands-agent@example.com>",
      true,
    ],
    [
      "Sourcegraph Cody",
      "fix\n\nCo-authored-by: Cody <cody@sourcegraph.com>",
      true,
    ],
  ])("%s -> %s", (_label, message, expected) => {
    expect(hasAICommitMetadata(message)).toBe(expected);
  });
});

describe("analyzeCommitMetadata", () => {
  it("returns zeros for empty input", () => {
    expect(analyzeCommitMetadata([])).toEqual({
      totalCommits: 0,
      aiCommits: 0,
      ratio: 0,
    });
  });

  it("counts all commits when none are AI-attributed", () => {
    const commits: GitHubCommit[] = [
      { sha: "a", message: "fix: a" },
      { sha: "b", message: "fix: b" },
    ];
    const result = analyzeCommitMetadata(commits);
    expect(result.totalCommits).toBe(2);
    expect(result.aiCommits).toBe(0);
    expect(result.ratio).toBe(0);
  });

  it("reports ratio of AI-attributed commits", () => {
    const commits: GitHubCommit[] = [
      { sha: "a", message: "fix: a" },
      {
        sha: "b",
        message: "feat: b\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      },
      {
        sha: "c",
        message:
          "feat: c\n\nCo-authored-by: GitHub Copilot <copilot@github.com>",
      },
    ];
    const result = analyzeCommitMetadata(commits);
    expect(result.totalCommits).toBe(3);
    expect(result.aiCommits).toBe(2);
    expect(result.ratio).toBeCloseTo(2 / 3, 5);
  });

  it("deduplicates commits by sha", () => {
    const commits: GitHubCommit[] = [
      {
        sha: "same",
        message: "feat\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      },
      {
        sha: "same",
        message: "feat\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      },
    ];
    const result = analyzeCommitMetadata(commits);
    expect(result.totalCommits).toBe(1);
    expect(result.aiCommits).toBe(1);
  });
});

describe("identify - AI commit metadata flag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(date);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeAICommits(count: number): GitHubCommit[] {
    return Array.from({ length: count }, (_, i) => ({
      sha: `ai-${i}`,
      message: `feat: change ${i}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`,
    }));
  }

  function makeHumanCommits(count: number): GitHubCommit[] {
    return Array.from({ length: count }, (_, i) => ({
      sha: `h-${i}`,
      message: `fix: change ${i}`,
    }));
  }

  function runWithCommits(commits: GitHubCommit[], excludeRepos?: string[]) {
    return identify({
      createdAt: "2025-01-01T00:00:00Z",
      reposCount: 10,
      accountName: "user",
      events: [],
      commits,
      excludeRepos,
    });
  }

  it("pushes a 0-point visibility flag at >= 90% AI ratio", () => {
    const result = runWithCommits([
      ...makeAICommits(9),
      ...makeHumanCommits(1),
    ]);
    const flag = result.flags.find(
      (f) => f.label === "Predominantly AI-attributed commits",
    );
    expect(flag).toBeDefined();
    expect(flag?.points).toBe(0);
    expect(flag?.detail).toMatch(/9\/10 commits \(90%\).*1\.5x multiplier/);
  });

  it.each<[number, number]>([
    [8, 2], // 80% — below extreme threshold
    [4, 6], // 40%
    [2, 8], // 20%
  ])("does not flag %i AI / %i human commits", (ai, human) => {
    const result = runWithCommits([
      ...makeAICommits(ai),
      ...makeHumanCommits(human),
    ]);
    expect(
      result.flags.some((f) => f.label.includes("AI-attributed commits")),
    ).toBe(false);
  });

  it("does not flag when below minimum commit count", () => {
    const result = runWithCommits(makeAICommits(3));
    expect(
      result.flags.some((f) => f.label.includes("AI-attributed commits")),
    ).toBe(false);
  });

  it("amplifies the score of other flags by 1.5x when active", () => {
    const commits = [...makeAICommits(9), ...makeHumanCommits(1)];
    // 14-day-old account triggers "Recently created" (20 points)
    const withMultiplier = identify({
      createdAt: new Date(date.getTime() - 14 * 86400000).toISOString(),
      reposCount: 10,
      accountName: "user",
      events: [],
      commits,
    });
    const withoutMultiplier = identify({
      createdAt: new Date(date.getTime() - 14 * 86400000).toISOString(),
      reposCount: 10,
      accountName: "user",
      events: [],
    });
    // 20 base points × 1.5 = 30 → humanScore 70 vs unmultiplied 80
    expect(withoutMultiplier.score).toBe(80);
    expect(withMultiplier.score).toBe(70);
  });

  it("does not amplify when no other flags are present", () => {
    const commits = [...makeAICommits(9), ...makeHumanCommits(1)];
    const result = runWithCommits(commits);
    expect(result.score).toBe(100);
  });

  it("respects excludeRepos for commits", () => {
    const commits: GitHubCommit[] = [
      ...Array.from({ length: 9 }, (_, i) => ({
        sha: `excluded-${i}`,
        message: `feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>`,
        repo: "user/skipme",
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        sha: `h-${i}`,
        message: `fix: change ${i}`,
        repo: "user/keep",
      })),
    ];
    const result = runWithCommits(commits, ["user/skipme"]);
    expect(
      result.flags.some((f) => f.label.includes("AI-attributed commits")),
    ).toBe(false);
  });
});
