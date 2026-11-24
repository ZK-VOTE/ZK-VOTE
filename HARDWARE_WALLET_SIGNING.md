# Hardware wallet signing for DAO multisig

## Scope and trust boundary

DAO administrator and multisig signer transactions may be signed with Ledger through the Stellar Wallets Kit Ledger module. The adapter lives in `frontend/src/lib/hardwareWallet.ts`; the page must provide a prepared Soroban transaction, its signer, and human-readable review fields. The device is asked to return its address before signing, and the adapter compares it with the signer being authorized. A changed wallet session, network mismatch, malformed XDR, changed transaction hash, missing signature, duplicate signer, signer outside the configured set, or unmet threshold aborts the flow.

The adapter never exports or stores a private key. It does not silently switch to a browser hot wallet if Ledger is disconnected, locked, rejects the request, or cannot decode an operation. Fallback is **explicit opt-in only**: return to the review screen and let the user intentionally select a separately connected software wallet, then re-review and sign the transaction again. Never reuse a Ledger failure as consent to fallback.

## Explicit transaction review

Before invoking `signSorobanTransactionWithHardware`, render at least:

- action/purpose and DAO/proposal identifier;
- source/signer address (full address, with copy affordance);
- network name and exact passphrase;
- destination/contract address and contract method;
- every contract argument that affects the action (role, member, threshold, signer list, etc.);
- fee, operation count, and any expiration/sequence constraints available from the prepared envelope.

The review fields are application-supplied display data; they do not prove the device understands every contract argument. Require the signer to compare the displayed details with the hardware screen. If the device presents only a generic hash or cannot render Soroban contract authorization, treat that as a limitation and do not claim independent on-device semantic verification.

## Supported devices and limitations

- **Ledger hardware wallet:** supported through the Ledger module exposed by the configured version of `@creit.tech/stellar-wallets-kit`, with the Stellar app installed and unlocked. Browser transport availability varies (USB/WebHID and browser/OS support); the wallet kit/module is responsible for connecting to the device.
- Other Wallets Kit modules may continue to be used as software-wallet transports. They are not hardware devices merely because they use the same signing API.
- Hardware signing is client-side Soroban transaction signing. Relayer key/HSM custody (#496) is a separate server-side boundary and is not changed by this feature.
- The threshold-crypto DKG contract stores/combines cryptographic key shares; it is not the DAO admin multisig and must not accept hardware-wallet secrets or signatures as DKG shares.
- Ledger firmware/app versions may not support all Soroban operations or provide semantic details for every contract call. Unsupported calls fail closed. Verify device support and transaction display on testnet before enabling an admin operation in production.

## Integration

1. Register the Ledger module in the `StellarWalletsKit` module list in `frontend/src/hooks/useWallet.ts` (do not remove existing wallet modules).
2. In DAO multisig UI, prepare the transaction and call `signSorobanTransactionWithHardware(kit, request)` after showing the review fields. The returned signed transaction/XDR is a signature contribution; it is not execution approval until the on-chain contract verifies the signer and threshold.
3. For M-of-N collection, collect one contribution per authorized address over the same transaction hash and call `collectMultisigHardwareSignatures`. Submit only after the threshold is met; keep signature verification and role authorization on-chain.
4. Do not have the backend sign for the human signer. Backend submission should accept/forward a client-signed envelope only after its existing auth, replay, and transaction validation rules.

Run the adapter tests with `cd frontend && npm run test:run -- src/lib/hardwareWallet.test.ts`, then `npm run type-check` and `npm run build`.
