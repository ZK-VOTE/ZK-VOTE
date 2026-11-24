// Supply-chain policy logic (SPIKE-125, ZV-067). Pure functions only: callers
// supply file contents, so CI can classify a pull request from its lockfile
// diff without installing or executing anything the pull request contains.

const JS_LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
]);
const CARGO_LOCKFILE = "Cargo.lock";
const IGNORED_SEGMENTS = new Set(["node_modules", "target", ".claude", ".git"]);
const MANIFESTS = new Set(["package.json", "Cargo.toml"]);
const NPM_DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
];

// ── paths ────────────────────────────────────────────────────────────────────

export function splitPath(file) {
  const parts = file.split("/");
  const name = parts.pop();
  return { dir: parts.length ? parts.join("/") : ".", name };
}

function ignored(file) {
  return file.split("/").some((part) => IGNORED_SEGMENTS.has(part));
}

/** `dir` may contain `*` for exactly one path segment. */
export function dirMatches(pattern, dir) {
  if (!pattern.includes("*")) return pattern === dir;
  const a = pattern.split("/");
  const b = dir.split("/");
  return (
    a.length === b.length && a.every((part, i) => part === "*" || part === b[i])
  );
}

export function isDependencyFile(file, policy) {
  if (ignored(file)) return false;
  const { name } = splitPath(file);
  return (
    JS_LOCKFILES.has(name) ||
    name === CARGO_LOCKFILE ||
    MANIFESTS.has(name) ||
    policy.policyFiles.includes(file)
  );
}

export function workspaceFor(file, policy) {
  const { dir, name } = splitPath(file);
  const manager =
    name === CARGO_LOCKFILE || name === "Cargo.toml" ? "cargo" : "npm";
  if (manager === "cargo") {
    // Every member crate shares the root Cargo workspace and its lockfile.
    return policy.workspaces.find((w) => w.manager === "cargo") ?? null;
  }
  return (
    policy.workspaces.find(
      (w) => w.manager === "npm" && dirMatches(w.dir, dir),
    ) ?? null
  );
}

// ── lockfile guard ───────────────────────────────────────────────────────────

/**
 * SPIKE-125: the lockfile CI installs is authoritative, so a workspace may have
 * exactly one. Returns a list of human-readable violations (empty = ok).
 */
export function checkLockfiles(files, policy) {
  const violations = [];
  const jsByDir = new Map();
  for (const file of files) {
    if (ignored(file)) continue;
    const { dir, name } = splitPath(file);
    if (JS_LOCKFILES.has(name)) {
      if (!jsByDir.has(dir)) jsByDir.set(dir, []);
      jsByDir.get(dir).push(file);
    }
    if (name === CARGO_LOCKFILE) {
      const cargo = policy.workspaces.find((w) => w.manager === "cargo");
      if (cargo && file !== cargo.lockfile) {
        violations.push(
          `${file}: second Cargo lockfile; every crate uses the workspace lockfile ${cargo.lockfile}`,
        );
      }
    }
  }
  for (const [dir, lockfiles] of [...jsByDir].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const workspace = policy.workspaces.find(
      (w) => w.manager === "npm" && dirMatches(w.dir, dir),
    );
    const expected = workspace?.lockfile
      ? splitPath(workspace.lockfile).name
      : null;
    if (lockfiles.length > 1) {
      const keep = expected
        ? `keep ${dir === "." ? "" : `${dir}/`}${expected}`
        : "keep the one CI installs";
      violations.push(
        `${dir}: ${lockfiles.length} lockfiles for one workspace (${lockfiles
          .map((f) => splitPath(f).name)
          .sort()
          .join(", ")}); ${keep} and delete the rest`,
      );
    } else if (expected && splitPath(lockfiles[0]).name !== expected) {
      violations.push(
        `${lockfiles[0]}: the inventory says ${dir} is installed from ${expected}; update supply-chain/dependency-policy.json or switch back`,
      );
    }
  }
  return violations;
}

// ── lockfile parsing ─────────────────────────────────────────────────────────

function addVersion(map, name, version) {
  if (!name || !version) return;
  if (!map.has(name)) map.set(name, new Set());
  map.get(name).add(version);
}

/** name -> Set(version) from an npm package-lock.json (v1, v2 or v3). */
export function parseNpmLock(text) {
  const map = new Map();
  if (!text) return map;
  const lock = JSON.parse(text);
  if (lock.packages) {
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key) continue; // the root project itself
      const at = key.lastIndexOf("node_modules/");
      const name =
        entry.name ??
        (at === -1 ? null : key.slice(at + "node_modules/".length));
      addVersion(map, name, entry.version);
    }
  } else if (lock.dependencies) {
    const walk = (deps) => {
      for (const [name, entry] of Object.entries(deps)) {
        addVersion(map, name, entry.version);
        if (entry.dependencies) walk(entry.dependencies);
      }
    };
    walk(lock.dependencies);
  }
  return map;
}

/** name -> Set(version) from a Cargo.lock. */
export function parseCargoLock(text) {
  const map = new Map();
  if (!text) return map;
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    addVersion(map, name, version);
  }
  return map;
}

/** name -> Set(spec) from a package.json's dependency fields. */
export function parsePackageJson(text) {
  const map = new Map();
  if (!text) return map;
  const manifest = JSON.parse(text);
  for (const field of NPM_DEP_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      addVersion(
        map,
        name,
        typeof spec === "string"
          ? `${field}:${spec}`
          : `${field}:${JSON.stringify(spec)}`,
      );
    }
  }
  return map;
}

/** name -> Set(spec) from a Cargo.toml's dependency tables (line-based). */
export function parseCargoToml(text) {
  const map = new Map();
  if (!text) return map;
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    if (!/(^|\.)(dev-|build-)?dependencies$/.test(section)) continue;
    const entry = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (entry) addVersion(map, entry[1], `${section}:${entry[2]}`);
  }
  return map;
}

export function parseDependencyFile(file, text) {
  const { name } = splitPath(file);
  if (name === "package-lock.json" || name === "npm-shrinkwrap.json")
    return parseNpmLock(text);
  if (name === CARGO_LOCKFILE) return parseCargoLock(text);
  if (name === "package.json") return parsePackageJson(text);
  if (name === "Cargo.toml") return parseCargoToml(text);
  return new Map();
}

/** Packages whose resolved versions or specs differ between two parses. */
export function diffPackages(before, after) {
  const changes = [];
  const names = new Set([...before.keys(), ...after.keys()]);
  for (const name of [...names].sort()) {
    const from = [...(before.get(name) ?? [])].sort();
    const to = [...(after.get(name) ?? [])].sort();
    if (from.join("|") !== to.join("|")) changes.push({ name, from, to });
  }
  return changes;
}

// ── classification ───────────────────────────────────────────────────────────

function matchesPattern(pattern, name) {
  if (!pattern.endsWith("*")) return pattern === name;
  return name.startsWith(pattern.slice(0, -1));
}

export function packageClass(name, policy) {
  for (const cls of ["ceremony-linked", "proof-sensitive"]) {
    if (
      (policy.packages[cls] ?? []).some((pattern) =>
        matchesPattern(pattern, name),
      )
    )
      return cls;
  }
  return "patch-safe";
}

export function strictest(classes, policy) {
  return classes.reduce(
    (best, cls) =>
      policy.classes[cls].rank > policy.classes[best].rank ? cls : best,
    "patch-safe",
  );
}

/**
 * Classify a change set. `changes` is a list of `{ path, before, after }` with
 * file contents (null when absent). Returns the strictest class, the reasons
 * for it, the touched workspaces and the parity jobs to run.
 */
export function classify(changes, policy) {
  const relevant = changes.filter((c) => isDependencyFile(c.path, policy));
  const workspaces = new Map();
  const packages = [];
  const reasons = [];
  const classes = [];

  for (const change of relevant) {
    if (policy.policyFiles.includes(change.path)) {
      classes.push("proof-sensitive");
      reasons.push(
        `${change.path} changed: dependency policy edits need maintainer sign-off`,
      );
      continue;
    }
    const workspace = workspaceFor(change.path, policy);
    if (workspace) {
      workspaces.set(workspace.id, workspace);
      if (workspace.defaultClass !== "patch-safe") {
        classes.push(workspace.defaultClass);
        reasons.push(
          `${change.path} is in the ${workspace.id} workspace (${workspace.defaultClass})`,
        );
      }
    }
    const diff = diffPackages(
      parseDependencyFile(change.path, change.before),
      parseDependencyFile(change.path, change.after),
    );
    for (const pkg of diff) {
      const cls = packageClass(pkg.name, policy);
      packages.push({ ...pkg, file: change.path, class: cls });
      if (cls !== "patch-safe") {
        classes.push(cls);
        reasons.push(`${pkg.name} (${change.path}) is ${cls}`);
      }
    }
  }

  const isDependencyUpdate = relevant.length > 0;
  const cls = strictest(classes, policy);
  return {
    isDependencyUpdate,
    class: isDependencyUpdate ? cls : null,
    label: isDependencyUpdate ? policy.classes[cls].label : null,
    signoffRequired: isDependencyUpdate && policy.classes[cls].signoff,
    ceremonyPlanRequired:
      isDependencyUpdate && policy.classes[cls].ceremonyPlan,
    reasons,
    workspaces: [...workspaces.keys()].sort(),
    packages,
    parity: isDependencyUpdate
      ? parityJobs(cls, [...workspaces.values()], policy)
      : [],
  };
}

/** GitHub Actions matrix entries for the class's parity commands. */
export function parityJobs(cls, workspaces, policy) {
  const jobs = [];
  for (const kind of policy.classes[cls].parity) {
    if (kind === "package-tests") {
      for (const w of [...workspaces].sort((a, b) =>
        a.id.localeCompare(b.id),
      )) {
        jobs.push({
          id: `package-tests:${w.id}`,
          name: `Package tests (${w.id})`,
          setup: w.test.setup.join(","),
          run: w.test.run,
        });
      }
    } else {
      const cmd = policy.parity[kind];
      jobs.push({
        id: kind,
        name: cmd.name,
        setup: cmd.setup.join(","),
        run: cmd.run,
      });
    }
  }
  return jobs;
}

// ── sign-off ─────────────────────────────────────────────────────────────────

/**
 * Decide whether a proof-sensitive or ceremony-linked PR has a recorded
 * maintainer sign-off. `reviews` are GitHub reviews with the reviewer's repo
 * permission attached: `{ user, state, commitId, body, permission }`.
 * Only each reviewer's latest review counts, it must approve the current head
 * commit, and the reviewer must be a maintainer other than the author.
 * Ceremony-linked updates also need a ceremony plan link in the approval and an
 * open, unexpired exception.
 */
export function evaluateSignoff({
  classification,
  reviews,
  headSha,
  author,
  exception,
  today,
  policy,
}) {
  if (!classification.isDependencyUpdate) {
    return {
      state: "success",
      description: "Not a dependency update",
      signers: [],
    };
  }
  if (!classification.signoffRequired) {
    return {
      state: "success",
      description: `${classification.class}: CI only, no sign-off needed`,
      signers: [],
    };
  }

  const latest = new Map();
  for (const review of reviews) {
    if (review.state === "COMMENTED") continue; // comments do not replace an approval
    latest.set(review.user, review);
  }
  const allowed = new Set(policy.signoff.maintainerPermissions);
  const pattern = new RegExp(policy.signoff.ceremonyPlanPattern, "i");
  const approvals = [...latest.values()].filter(
    (r) =>
      r.state === "APPROVED" &&
      r.commitId === headSha &&
      r.user !== author &&
      allowed.has(r.permission),
  );
  const signers = approvals.map((r) => r.user).sort();

  if (approvals.length === 0) {
    return {
      state: "failure",
      description: `${classification.class}: needs a maintainer approval of the current commit`,
      signers,
    };
  }
  if (classification.ceremonyPlanRequired) {
    if (!approvals.some((r) => pattern.test(r.body ?? ""))) {
      return {
        state: "failure",
        description:
          "ceremony-linked: approval must include 'Ceremony plan: <link>'",
        signers,
      };
    }
    if (!exception || exception.state !== "open") {
      return {
        state: "failure",
        description: "ceremony-linked: no open tracking exception",
        signers,
      };
    }
    if (!exception.expiresAt || exception.expiresAt < today) {
      return {
        state: "failure",
        description: `ceremony-linked: exception #${exception.number} expired ${exception.expiresAt ?? "(no date)"}`,
        signers,
      };
    }
  }
  return {
    state: "success",
    description: `${classification.class}: signed off by ${signers.join(", ")}`,
    signers,
  };
}

// ── ceremony exception ───────────────────────────────────────────────────────

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const exceptionMarker = (pr) =>
  `<!-- supply-chain-exception pr=${pr} -->`;

export function exceptionTitle(pr) {
  return `Supply-chain exception: ceremony-linked update in PR #${pr}`;
}

export function exceptionBody({ pr, classification, today, policy }) {
  const expires = addDays(today, policy.exceptionExpiryDays);
  const pkgs = classification.packages
    .filter((p) => p.class === "ceremony-linked")
    .map(
      (p) =>
        `| \`${p.name}\` | ${p.from.join(", ") || "(new)"} | ${p.to.join(", ") || "(removed)"} | \`${p.file}\` |`,
    );
  return [
    exceptionMarker(pr),
    `Opened: ${today}`,
    `Expires: ${expires}`,
    "",
    `PR #${pr} changes ceremony-linked dependencies. Under SPIKE-125 it needs a new ceremony plan and is tracked as an exception until that plan is executed or the update is withdrawn.`,
    "",
    "| Package | From | To | File |",
    "| --- | --- | --- | --- |",
    ...(pkgs.length ? pkgs : ["| (workspace default) | | | |"]),
    "",
    "Why it is ceremony-linked:",
    ...classification.reasons.map((r) => `- ${r}`),
    "",
    "Before merge:",
    "- [ ] Ceremony plan written and linked in the maintainer approval as `Ceremony plan: <link>`",
    "- [ ] Parity matrix green on the PR (package tests, circuit KATs, rebuild-compare, proof corpus)",
    "- [ ] Participants, transcript location and random beacon recorded in the plan",
    "",
    `This exception expires on ${expires}. After that the sign-off check fails until it is renewed (edit the Expires line, with a reason) or the PR is closed.`,
  ].join("\n");
}

export function parseExpiry(body) {
  return /^Expires:\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(body ?? "")?.[1] ?? null;
}

// ── reporting ────────────────────────────────────────────────────────────────

export function summaryMarkdown(classification) {
  if (!classification.isDependencyUpdate)
    return "No dependency manifests or lockfiles changed.\n";
  const lines = [
    `### Dependency update: \`${classification.class}\``,
    "",
    `Sign-off required: **${classification.signoffRequired ? "yes" : "no"}**` +
      (classification.ceremonyPlanRequired
        ? " · ceremony plan and tracking exception required"
        : ""),
    "",
  ];
  if (classification.reasons.length) {
    lines.push("Reasons:", ...classification.reasons.map((r) => `- ${r}`), "");
  }
  if (classification.packages.length) {
    lines.push(
      "| Package | Class | From | To | File |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const p of classification.packages) {
      lines.push(
        `| \`${p.name}\` | ${p.class} | ${p.from.join(", ") || "(new)"} | ${p.to.join(", ") || "(removed)"} | \`${p.file}\` |`,
      );
    }
    lines.push("");
  }
  lines.push(
    "Parity commands:",
    ...classification.parity.map((j) => `- **${j.name}**: \`${j.run}\``),
    "",
  );
  return lines.join("\n");
}
