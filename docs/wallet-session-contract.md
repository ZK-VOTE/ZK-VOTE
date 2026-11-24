# Wallet Session Contract (#750 / SPIKE-080)

Proofs take about 60 seconds. During that time a wallet can disconnect, lock, switch
accounts or switch networks. This document defines what the app does in each case.
Code: `frontend/src/lib/walletSession.ts` (client) and
`backend/src/services/voteSession.ts` (relayer).

## Model

| Concept | What it is |
|---|---|
| **Session** | One account on one network. A single module-level store holds it, because four components call `useWallet()` and each has its own React state. |
| **Generation** | A counter that goes up whenever the account or network changes, or the wallet disconnects. Long flows snapshot it at the start and check it before acting. |
| **Binding** | Every proof is bound to `(account tag, network hash)`. The account tag is `SHA-256("zkvote-account-tag-v1:" + address)`, so the raw address is never stored next to the ballot (#644). |
| **Relayer session** | A random 32-byte HMAC key, registered with `POST /vote-session` with no wallet address. Each `/vote` carries `X-Vote-Session`, `X-Vote-Session-Mac` and `X-Vote-Network`. The client revokes the session on every generation change. |

On every generation change the client also clears all React Query caches. This
closes the stale-account-read gap from §8: `clearAllQueryCaches` already had
callers for account change and disconnect, but none for a network switch.

## Spike answers

**Session binding.** Generations protect in-flight work in the browser. Bindings
protect queued proofs. Relayer sessions protect against replay after the session
ends. Relayer sessions are unlinkable random ids, so binding a vote to a session
never links the wallet to the ballot.

**Network enforcement** happens at three points, and each one blocks rather than
showing a banner:

| Point | Check | User sees |
|---|---|---|
| Build | `assertCanBuild` before credentials load | "Your wallet is on futurenet, but this app uses testnet. Switch networks…" |
| Submit | The queue holds the entry, and the relayer rejects `X-Vote-Network` mismatches with 409 `NETWORK_MISMATCH` | The vote is held: "Switch your wallet back to testnet to submit this vote." |
| Confirm | Session registration is refused on a different network (409) | No session is opened, so nothing can be submitted |

Networks are compared by passphrase. The old check tested whether the passphrase
contained the name Freighter reports. "TESTNET" never matches "Test SDF Network ;
September 2015", so testnet users always saw the warning and learned to dismiss it.

**Resume.**

| Artifact | Survives a session change? |
|---|---|
| Finished proof (queued payload) | Yes. It is held for the account and network that built it and resumes when they reconnect. No re-prove is needed, and the nullifier keeps it from counting twice. |
| Proof in progress | No. Checkpoints before proving abort it with "Nothing was submitted". A proof that finishes after the switch is held instead of sent. |
| Relayer session | No. It is revoked, and a new one opens on the next submit. |
| Query caches | No. They are cleared. |
| Credentials (`zk.ts`) | Unchanged. They are keyed by `(daoId, publicKey)`, so another account never reads them. |
| Pay / Swap / Deposit forms, quotes, anchor windows | No. A quote is dropped, an open anchor window is closed, and a submit asks the user to review the form again. |

Explicit disconnect used to call `submissionQueue.clearAll()`, which deleted proofs
that hadn't been sent yet. It now calls `clearSettled()`: sent, failed and conflict
history is cleared, and unsent proofs are kept. Unsent proofs hold no secrets, only
the formatted proof and public signals, encrypted at rest.

**Wrong-account payments.** Pay and Swap are signed by the relayer's own key behind
`masterKeyGuard`, and Deposit/Withdraw takes a typed account. None of them sign with
the user's wallet, so a quote-to-submit account switch cannot move funds from the
wrong account. The real risk is a form filled in under one session and sent after a
switch. That is prevented: `useSessionBoundForm` blocks the submit until the user
reviews it again. Votes use prevention (holding) plus detection (see the collision
case below). Reversal is not possible on-chain.

## Wallet-event matrix

| Wallet / case | Account switch | Network switch | Lock | Disconnect | Delivery |
|---|---|---|---|---|---|
| Freighter, with event API | `onAccountChange` → new generation | `onNetworkChange` → passphrase compare | Reported as an empty account → session ends | `disconnect()` → session ends | Event |
| Freighter, without event API | Polled every 2 s | Polled every 3 s | Empty key → session ends | Same as above | Polling |
| xBull (kit) | No event; caught by `verifyLiveAccount` before signing | No event; the kit signs for the kit's network | `getAddress` fails → session ends | Same as above | Checked before signing |
| Albedo (kit) | Can change on every request (each signature is a popup); caught by `verifyLiveAccount` | Same as xBull | Not applicable | Same as above | Checked before signing; may show an extra popup |
| **Malicious module** in the kit list | Module reports a different account than the extension: `verifyLiveAccount` notices, the checkpoint aborts, and a finished proof is held for the original account | — | — | — | Checked before signing |
| **Transient unlock** (an attacker briefly holds an unlocked wallet) | See the next section | — | — | — | — |

Not verified in a real browser: `services/freighter.ts` only listens through
`window.freighter`. Current Freighter builds may expose only the `freighter-api`
message channel. In that case neither events nor polling fire, and the check before
signing plus the relayer-side checks are what protect the user. Retest this matrix
with each wallet SDK release. The SDK versions are pinned in `package.json`.

## Tier-1: transient compromise and vote theft

**What is prevented:**
- A captured payload or headers cannot be submitted after the victim's session ends.
  The relayer answers 401 `VOTE_SESSION_STALE`.
- The victim's MAC cannot be reused under another session id, and no bound field
  (including the choice) can be altered. The relayer answers 401 `VOTE_SESSION_INVALID`.
- A proof built by account A is never sent while B is connected.

**What is detected:** credentials can be re-derived from a single wallet signature
(`zk.ts`). Someone with brief access to an unlocked wallet can therefore produce
their own valid proof for the victim's nullifier and submit it first. A session
cannot stop this, because the attacker opens their own. Instead, the relayer records
which session spent each nullifier. When the victim submits later, the 409 carries
`conflictSource: "other_session"`, and the victim sees: "Your voting credentials were
already used … from another session or device. If that wasn't you, someone may have
had access to your wallet." This is detection, not prevention.

**What is left:** prevention requires credentials that cannot be re-derived from a
single signature, for example a device-held secret mixed into the derivation. That
changes registration and recovery, so it is left for a follow-up.

## Relayer rollout

1. Deploy the backend. Bound votes are verified; unbound votes are still accepted.
2. Deploy the frontend. It sends bindings on every vote.
3. Set `VOTE_SESSION_REQUIRED=true`. Unbound votes are then rejected with 401
   `VOTE_SESSION_REQUIRED`.

Sessions are kept in memory: TTL 2 h, at most 50,000 (oldest evicted first). After a
restart every session reads as stale, and the client re-registers and retries. It
does not fail the vote.

## Tests

- `backend/tests/vote-session.test.ts`: session lifecycle, revoked/expired/unknown
  sessions, network enforcement, the required flag, the victim-vs-attacker race
  (re-bound payload, tampered choice, credential theft attributed), wiring into the
  real `/vote` route, and the eviction bound.
- `frontend/src/lib/walletSession.test.ts`: generations, cache clearing, passphrase
  matching, hold/resume, stale replay, restart recovery, no double vote, collision
  message, and disconnect keeping unsent proofs. Runs against a fake relayer that
  implements the backend's protocol.
- `frontend/src/hooks/useWallet.session.test.ts`: the scripted wallet harness
  (`src/test/fakeWallet.ts`) for account and network switches, lock, polling-only
  Freighter, disconnect, and a malicious module.
- `frontend/src/components/VoteModal.test.tsx`: blocked at build time (network and
  account), aborted before proving, held after an account switch or network switch,
  and continued after a same-account reconnect.
