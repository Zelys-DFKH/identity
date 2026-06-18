# identity

This is a TypeScript library for detecting automation abuse in GitHub accounts. It analyzes an account's public event history and profile data, runs it through a set of behavioral checks, and produces a score between 0 and 100 — where 100 is "this looks like a real person" and 0 is "this looks like a machine."

## Why this fork exists

The upstream project frames the problem as detecting "AI agents and automated activity" broadly. That framing caught too much collateral damage — prolific contributors, developers who iterate quickly, people who use AI coding tools — and the maintainers weren't interested in adding signals that credit legitimate human behavior. After offering these improvements upstream and getting them declined, I forked.

The goal here is narrower: detect genuine abuse patterns — bot farms running PR spam campaigns, fake contribution schemes, automated accounts that farm stars or flood maintainers with activity. Not every fast-moving contributor. Not every person who uses AI tools to write code.

## How it works

The library exports a single `identify()` function. You pass it a GitHub user's account metadata, their recent public events, and optionally their repository list and recent commits. It runs those inputs through about two dozen detectors and returns:

```ts
{
  score: number,           // 0–100; higher = more human
  confidence: number,      // 20–95; how many signals corroborate the classification
  classification: string,  // "organic" | "mixed" | "automation" | "likely_spam" | "legitimate_automation"
  flags: IdentifyFlag[],   // every signal that fired, with point values and details
  profile: { age: number, repos: number }
}
```

Each detector returns flags. Flags with positive points are suspicious signals — they push the score toward automation. Flags with negative points are human credit signals — they pull the score back toward organic. The raw sum of flag points gets inverted to produce the final 0–100 score.

Scores of 70 or above classify as `organic`. Between 50 and 70 is `mixed` — something unusual showed up, but there's also evidence of genuine human activity. Below 50 is `automation` by default, or `likely_spam` if one of the explicit spam patterns fired. Known service accounts and bots are classified as `legitimate_automation` immediately, before any scoring happens.

Two things refine the score beyond the straight flag sum. If the commit history contains a high proportion of AI-attributed commit messages, suspicious flags marked as `amplifiable` get multiplied — this isn't a penalty for using AI tools, it's a way to increase confidence when automation signals already exist and the commits reinforce them. Recent activity also counts more than old activity, so a spam campaign from last week outweighs one from six months ago.

## What it checks

### Suspicious signals

**Account age.** Newly created accounts (under 30 days) and young accounts (under 90 days) start with a small penalty. This isn't because new contributors are untrustworthy — it's because bot operators routinely create fresh accounts to avoid history-based detection. The penalty is mild and easily outweighed by other signals.

**Mass forking.** Forking 8 or more repositories within 24 hours is a common automation pattern. Star-farming tools, fake engagement campaigns, and contribution-farming scripts all tend to fork-then-do-something in bulk. The thresholds scale: 8–19 forks in a day is suspicious, 35+ is severe.

**24/7 activity and throughput limits.** If an account has essentially no rest window on a given day — active across nearly every hour with fewer than three hours quiet — that's a strong signal. The throughput ceiling goes further: 150 or more write events in a two-hour window is physically beyond what a person can do. That's a machine.

**No circadian pattern.** Across the full event history, a real person's activity will cluster somewhere in the day and go quiet somewhere else. Accounts with no consistent quiet window score higher on this signal.

**Comment spam.** Large bursts of comments spread across many different repositories in a short time window. The check looks for spray patterns — not volume alone, but volume plus distribution. That's the signature of a bot posting templated comments to hundreds of projects.

**PR spam.** Extreme pull request volume: 30 or more PRs in a 24-hour window, 100 or more in a week. There's also a distributed spam check that catches lower-volume but widespread patterns — many PRs across many repositories at a pace that doesn't match organic open-source participation.

**Fork automation with downstream PRs.** The branch and PR automation detector looks for patterns where accounts fork repositories and immediately open pull requests in bulk. That's the classic structure of automated contribution farms.

**Rapid and closed PR spam.** PRs opened very quickly in succession, and accounts with high rates of PRs getting closed without merging, are both signals. The second matters because spam PRs and low-quality automated contributions get closed at higher rates than genuine ones.

**Behavioral monoculture.** Accounts that only do one type of thing — only fork, only comment, only open issues — show the narrow footprint of a script. Real contributors mix it up.

**Thin profile and no repos.** An account with no profile information, no public repositories, but high activity on other people's projects is a common bot shape. This combines with other signals rather than flagging on its own.

**Issue and star bursts.** Rapid-fire issue creation across many repositories, and star concentrations toward a single organization's repos, both follow patterns seen in coordinated campaigns.

**No reciprocity.** Accounts that only consume — starring, watching, forking — without ever contributing back are flagged. Real open-source participants, even casual ones, eventually push code, open an issue, or leave a comment.

### Human credit signals

Every suspicious signal above is balanced by signals that actively credit human behavior. These work as negative-point flags that pull the score back toward organic.

**Merged contributions.** If the account has had pull requests merged in external repositories, that's strong evidence of real engagement. Other people looked at the code, reviewed it, and accepted it. This is the hardest signal to fake at scale.

**Code review participation.** Leaving reviews on other people's pull requests — and especially leaving inline comments on specific lines of code — is something bots rarely do convincingly. This signal rewards reviewers.

**PR iteration cycles.** When a pull request goes through synchronize events — meaning the contributor pushed updates in response to review feedback — that back-and-forth is a human pattern. Automated submissions don't iterate.

**Long-span engagement.** Contributing to the same repository across many days or weeks, rather than doing it all at once and moving on, suggests ongoing investment in a project.

**Day-of-week variation.** Human activity tends to look different on weekdays versus weekends. Accounts with natural variance in their day-of-week distribution get credit for this.

**Dormancy gaps.** Having a quiet stretch in the event history — a period where the account went inactive — is a human signal. Bots don't take breaks.

**Pre-AI development history.** Repositories created before 2022 suggest the account was active before AI coding tools were common. That's consistent with an established developer.

**Account seniority.** Older accounts carry more weight not because age is proof, but because they've had more opportunities to build a track record.

**Followers.** Being followed by other GitHub accounts signals that real people found this account worth tracking.

**Identity completeness.** A filled-out profile — name, bio, company, location — is a small but real signal. Not sufficient on its own, but it adds to the picture.

**Circadian presence.** A consistent quiet window across many days of activity means the account has a sleep schedule. That's a human pattern.

**Gist activity.** Using gists suggests someone writing code for themselves, not just running scripts against other people's repositories.

## What this doesn't do

This library doesn't determine whether someone is using AI coding tools. Using AI assistants, generating commit messages with a language model, or getting code help from any AI tool doesn't make you a bot and doesn't affect your classification. The AI commit attribution check only amplifies existing automation signals — it has no effect if those signals aren't already present.

It also doesn't penalize prolific contributors. Someone genuinely active across many repositories, who opens many pull requests and moves fast, will score well on the human credit signals. Those signals are designed to outweigh the volume-based suspicious ones for legitimate contributors.

The results are indicators, not verdicts. An `automation` classification means the behavioral pattern looks more like a machine than a person — it's a starting point for investigation, not proof of bad intent.

## Usage

```ts
import { identify } from "@unveil/identity"; // upstream package name; this fork is not published to npm

const result = identify({
  createdAt: user.created_at,
  reposCount: user.public_repos,
  accountName: user.login,
  events,          // from GET /users/{username}/events/public
  repos,           // from GET /users/{username}/repos (optional, improves pre-AI history check)
  commits,         // recent commit messages (optional, enables AI attribution check)
  profile: {
    followers: user.followers,
    name: user.name,
    company: user.company,
    location: user.location,
    blog: user.blog,
    bio: user.bio,
  },
});
```

## Contributing and thresholds

All detection thresholds live in `src/config.ts`. They're calibrated against a fixture set of real accounts in `test/fixtures/` and validated by the regression test suite. Before changing a threshold, run `pnpm test` and check that the regression fixtures still classify as expected — the goal is to improve accuracy, not to chase a specific fixture's result.

If you're adding a new detector, add it to both the detection pipeline in `src/identify.ts` and a corresponding test. The main gate is `test/regression-iter4.test.ts`.

This fork diverges from the upstream `@unveil/identity` package and is not published to npm.
