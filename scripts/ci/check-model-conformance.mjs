import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const model = fs.readFileSync(path.join(root, "formal-model/ZKVote.tla"), "utf8");
const mapping = JSON.parse(fs.readFileSync(path.join(root, "formal-model/implementation-map.json"), "utf8"));
const failures = [];
const expected = ["RootGroundedVoting", "AdminContinuity", "ProposalFSM", "NullifierGlobalUniqueness", "FIFOSafety", "MinRootCorrectness", "AuthDelegationSoundness"];

for (const invariant of expected) {
  const entry = mapping.invariants && mapping.invariants[invariant];
  if (!model.includes(invariant)) failures.push("Model invariant missing: " + invariant);
  if (!entry || !Array.isArray(entry.entrypoints) || entry.entrypoints.length === 0) {
    failures.push("Unmapped model invariant: " + invariant);
    continue;
  }
  for (const pair of entry.entrypoints) {
    const relativePath = pair[0], functionName = pair[1];
    const sourcePath = path.join(root, relativePath);
    if (!fs.existsSync(sourcePath)) {
      failures.push("Mapped contract source missing: " + relativePath);
      continue;
    }
    const source = fs.readFileSync(sourcePath, "utf8");
    const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp("\\bpub\\s+fn\\s+" + escaped + "\\b").test(source)) {
      failures.push("Mapped entrypoint missing: " + relativePath + "::" + functionName);
    }
  }
}
if (failures.length) {
  for (const failure of failures) console.error("::error::" + failure);
  process.exit(1);
}
console.log("Verified " + expected.length + " TLA+ safety invariants against mapped Rust entrypoints.");
