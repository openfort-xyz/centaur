import { setTimeout as delay } from "node:timers/promises";

import type { PrManagerContext } from "./pr-manager";
import type { GithubbotOptions } from "./types";

export type PolicyTarget = {
  owner: string;
  repo: string;
  number: number;
  head: string;
  base: string;
};
type Decision =
  | { action: "merge" | "managed" | "wait" }
  | { action: "needs_human"; reason: string };

const wait: Decision = { action: "wait" };

/** Ask the deployment's trusted policy provider about this PR and commit only. */
export async function readMergePolicy(
  options: GithubbotOptions,
  target: PolicyTarget,
): Promise<Decision> {
  if (!options.mergePolicyUrl) return wait;
  const endpoint = new URL(options.mergePolicyUrl);
  if (endpoint.protocol !== "https:") throw new Error("Merge policy URL must use HTTPS");
  const url = `https://github.com/${target.owner}/${target.repo}/pull/${target.number}`;
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("head", target.head);
  endpoint.searchParams.set("base", target.base);
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.mergePolicyClientId && options.mergePolicyClientSecret) {
    headers["CF-Access-Client-Id"] = options.mergePolicyClientId;
    headers["CF-Access-Client-Secret"] = options.mergePolicyClientSecret;
  }
  // The provider starts the AI review once. Keep this webhook alive to pick up its
  // result even when no further GitHub event follows the last green check.
  const deadline = Date.now() + 11 * 60_000;
  while (Date.now() < deadline) {
    const response = await (options.fetch ?? fetch)(endpoint, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Merge policy returned HTTP ${response.status}`);
    const verdict = await response.json();
    if (verdict?.url !== url || verdict.head !== target.head || verdict.base !== target.base)
      return wait;
    if (verdict.action === "needs_human" && typeof verdict.reason === "string") {
      return { action: "needs_human", reason: verdict.reason };
    }
    if (verdict.action === "merge" || verdict.action === "managed")
      return { action: verdict.action };
    if (verdict.action !== "reviewing") return wait;
    await delay(5_000);
  }
  return wait;
}

/** Read current, non-dismissed GitHub reviews. User-type bot principals must
 * also be excluded by the deployment's named list of human reviewers. */
export async function humanApproved(ctx: PrManagerContext, target: PolicyTarget): Promise<boolean> {
  const humans = new Set(ctx.options.humanReviewers?.map((name) => name.toLowerCase()));
  if (!humans.size) return false;
  const reviews = await ctx.octokit.paginate(ctx.octokit.rest.pulls.listReviews, {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.number,
    per_page: 100,
  });
  // GitHub returns reviews chronologically. Comments do not revoke an opinion;
  // a later dismissal or change request does.
  const approvals = new Set<string>();
  for (const review of reviews) {
    const login = review.user?.login.toLowerCase();
    if (!login || !humans.has(login) || login === ctx.userName.toLowerCase()) continue;
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    approvals.delete(login);
    if (
      review.state === "APPROVED" &&
      review.user?.type === "User" &&
      review.commit_id === target.head
    )
      approvals.add(login);
  }
  return approvals.size > 0;
}
