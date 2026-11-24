// Read-only git helpers: file contents come from `git show`, so classifying a
// pull request never installs or runs anything it contains.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const POLICY_PATH = "supply-chain/dependency-policy.json";

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

export function showFile(ref, path) {
  try {
    return git(["show", `${ref}:${path}`]);
  } catch {
    return null; // file absent at that ref
  }
}

export function changedFiles(base, head) {
  return git(["diff", "--name-only", `${base}...${head}`])
    .split("\n")
    .filter(Boolean);
}

export function mergeBase(base, head) {
  return git(["merge-base", base, head]).trim();
}

export function trackedFiles() {
  return git(["ls-files"]).split("\n").filter(Boolean);
}

/**
 * The policy is read from `ref` (the PR's base) so a PR cannot weaken its own
 * classification. Falls back to the working tree only when the base has no
 * policy yet, i.e. on the PR that introduces it.
 */
export function loadPolicy(ref) {
  const text = ref ? showFile(ref, POLICY_PATH) : null;
  if (text) return JSON.parse(text);
  if (ref)
    console.warn(
      `::warning::${POLICY_PATH} not found at ${ref}; using the working-tree copy`,
    );
  return JSON.parse(readFileSync(POLICY_PATH, "utf8"));
}

export function changesBetween(base, head) {
  const from = mergeBase(base, head);
  return changedFiles(from, head).map((path) => ({
    path,
    before: showFile(from, path),
    after: showFile(head, path),
  }));
}
