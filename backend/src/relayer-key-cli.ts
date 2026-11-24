#!/usr/bin/env tsx
/**
 * Relayer Key Lifecycle CLI (#746)
 *
 * Thin client for the running relayer's /admin/relayer endpoints, so planned
 * rotation and compromise response are a couple of commands, not a release.
 * It deliberately does not load the relayer config: it runs from an operator
 * laptop or a co-signer's machine during an incident.
 *
 * Environment:
 *   RELAYER_URL         base URL of the relayer (default http://localhost:3001)
 *   RELAYER_AUTH_TOKEN  admin master key (all commands except `approve`)
 *   RELAYER_COSIGNER_ID / RELAYER_COSIGNER_SECRET  this co-signer (`approve` only)
 *
 * Usage:
 *   tsx src/relayer-key-cli.ts status
 *   tsx src/relayer-key-cli.ts rotate [--target <keyId|G...>] [--actor <name>] [--reason <text>]
 *   tsx src/relayer-key-cli.ts rollback [--actor <name>] [--reason <text>]
 *   tsx src/relayer-key-cli.ts finalize [--actor <name>]
 *   tsx src/relayer-key-cli.ts compromise --key <keyId|G...> --declared-by <name> --reason <text> [--confirmation <token>]
 *   tsx src/relayer-key-cli.ts sweep --key <keyId|G...> --requested-by <name> --confirmation <token>
 *   tsx src/relayer-key-cli.ts halt --reason <text> [--actor <name>]
 *   tsx src/relayer-key-cli.ts resume [--actor <name>]
 *   tsx src/relayer-key-cli.ts approve --action <sweep:G...|compromise:G...> [--ttl-seconds 600]
 *
 * Compromise runbook (target: inside RELAYER_COMPROMISE_SLO_SECONDS):
 *   1. compromise --key <G...> --declared-by <you> --reason "<evidence>"
 *      → key revoked at once; a funded standby is active, or signing halted.
 *   2. A second person runs: approve --action sweep:<G...>  and sends the token.
 *   3. sweep --key <G...> --requested-by <you> --confirmation <token>
 *   4. status → check readiness.fundedStandbyKeys; register + fund a new
 *      standby (POST /admin/relayer/keys/generate, /fund) to reconstitute.
 */

import { issueActionApproval } from "./services/relayer-signing-policy.js";

// Command output is this tool's interface (operators pipe it), so it goes to
// stdout directly rather than through the structured service logger.
function out(text: string): void {
  process.stdout.write(`${text}
`);
}

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = "true";
    } else {
      flags[name] = next;
      i++;
    }
  }
  return { command, flags };
}

function required(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) {
    console.error(`Missing --${name}`);
    process.exit(2);
  }
  return value;
}

async function call(method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
  const base = (process.env.RELAYER_URL || "http://localhost:3001").replace(/\/$/, "");
  const token = process.env.RELAYER_AUTH_TOKEN;
  if (!token) {
    console.error("RELAYER_AUTH_TOKEN is required");
    process.exit(2);
  }
  const started = Date.now();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  out(JSON.stringify({ httpStatus: res.status, elapsedMs: Date.now() - started, ...json }, null, 2));
  if (!res.ok) process.exit(1);
}

function compact(flags: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(flags).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "status":
      return call("GET", "/admin/relayer/rotation");
    case "rotate":
      return call(
        "POST",
        "/admin/relayer/rotate",
        compact({ targetKeyId: flags.target, actor: flags.actor, reason: flags.reason }),
      );
    case "rollback":
      return call("POST", "/admin/relayer/rotation/rollback", compact({ actor: flags.actor, reason: flags.reason }));
    case "finalize":
      return call("POST", "/admin/relayer/rotation/finalize", compact({ actor: flags.actor }));
    case "compromise":
      return call(
        "POST",
        "/admin/relayer/compromise",
        compact({
          key: required(flags, "key"),
          declaredBy: required(flags, "declared-by"),
          reason: required(flags, "reason"),
          confirmation: flags.confirmation,
        }),
      );
    case "sweep":
      return call("POST", "/admin/relayer/sweep", {
        key: required(flags, "key"),
        requestedBy: required(flags, "requested-by"),
        confirmation: required(flags, "confirmation"),
      });
    case "halt":
      return call("POST", "/admin/relayer/halt", compact({ reason: required(flags, "reason"), actor: flags.actor }));
    case "resume":
      return call("POST", "/admin/relayer/resume", compact({ actor: flags.actor }));
    case "approve": {
      const id = process.env.RELAYER_COSIGNER_ID;
      const secret = process.env.RELAYER_COSIGNER_SECRET;
      if (!id || !secret) {
        console.error("RELAYER_COSIGNER_ID and RELAYER_COSIGNER_SECRET are required");
        process.exit(2);
      }
      const ttlMs = Number(flags["ttl-seconds"] ?? 600) * 1000;
      out(issueActionApproval(id, secret, required(flags, "action"), Date.now() + ttlMs));
      return;
    }
    default:
      out(
        "Commands: status | rotate | rollback | finalize | compromise | sweep | halt | resume | approve\n" +
          "See the header of src/relayer-key-cli.ts for flags and the compromise runbook.",
      );
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
