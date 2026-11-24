import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const model = fs.readFileSync(path.join(root, "formal-model/ZKVote.tla"), "utf8");
const mapping = JSON.parse(fs.readFileSync(path.join(root, "formal-model/implementation-map.json"), "utf8"));
const failures = [];
const expectedInvariants = ["RootGroundedVoting", "AdminContinuity", "ProposalFSM", "NullifierGlobalUniqueness", "FIFOSafety", "MinRootCorrectness", "AuthDelegationSoundness"];
const nextStart = model.indexOf("Next ==");
const nextEnd = model.indexOf("The complete specification", nextStart);
if (nextStart < 0 || nextEnd < 0) failures.push("Unable to locate the TLA+ Next-state relation");
const nextBlock = nextStart >= 0 && nextEnd > nextStart ? model.slice(nextStart, nextEnd) : "";
const modelActions = new Set(Array.from(nextBlock.matchAll(/\b([A-Z][A-Za-z0-9]+)\s*\(/g), (match) => match[1]));

function verifyEntrypoints(label, entry) {
  if (!entry || !Array.isArray(entry.entrypoints) || entry.entrypoints.length === 0) {
    failures.push("No contract entrypoint mapping for " + label);
    return;
  }
  for (const pair of entry.entrypoints) {
    const relativePath = pair[0], functionName = pair[1];
    const sourcePath = path.join(root, relativePath);
    if (!fs.existsSync(sourcePath)) {
      failures.push("Mapped contract source missing: " + relativePath);
      continue;
    }
    const source = fs.readFileSync(sourcePath, "utf8");
    if (!new RegExp("\\bpub\\s+fn\\s+" + functionName + "\\b").test(source)) {
      failures.push("Mapped entrypoint missing: " + relativePath + "::" + functionName);
    }
  }
}
for (const invariant of expectedInvariants) {
  if (!model.includes(invariant)) failures.push("Model invariant missing: " + invariant);
  verifyEntrypoints("invariant " + invariant, mapping.invariants && mapping.invariants[invariant]);
}
for (const action of modelActions) {
  verifyEntrypoints("model action " + action, mapping.actions && mapping.actions[action]);
}
for (const action of Object.keys(mapping.actions || {})) {
  if (!modelActions.has(action)) failures.push("Mapping references action absent from Next: " + action);
}
if (failures.length) {
  for (const failure of failures) console.error("::error::" + failure);
  process.exit(1);
}
console.log("Verified " + modelActions.size + " TLA+ actions and " + expectedInvariants.length + " safety invariants against Rust entrypoints.");
