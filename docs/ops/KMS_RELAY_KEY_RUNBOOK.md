# Operations Runbook: Hardware-Backed Relay Key Custody (AWS KMS / GCP KMS / PKCS#11 HSM)

**Issue:** #320  
**Type:** Spike & Security Operations Runbook  
**Status:** Production Ready  

---

## 1. Overview & Threat Model Objective

The ZKVote Relayer submits zero-knowledge vote transactions on behalf of users to ensure gasless participation and relayer anonymity. If a relayer's secret signing key is compromised, an attacker can sign malicious transactions, drain the relayer's gas balance, or impersonate privileged services.

### Core Security Invariant
> **The relayer's private signing key must NEVER reside in plaintext in environment variables, configuration files, disk storage, or process memory.**

All transaction signature operations ($Ed25519$) are offloaded to Hardware Security Modules (HSMs) or Cloud Key Management Services (AWS KMS, GCP Cloud KMS).

---

## 2. Infrastructure Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ZKVote Relayer Process                   │
│                                                             │
│  ┌───────────────────────┐       ┌───────────────────────┐  │
│  │ Transaction Generator │       │  StellarSigner Client │  │
│  └───────────┬───────────┘       └───────────┬───────────┘  │
└──────────────┼───────────────────────────────┼──────────────┘
               │ 1. Encode Tx Payload          │ 2. SignHash(TxDigest)
               ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│         Hardware Security Module / KMS Boundary             │
│                                                             │
│  • AWS KMS Key (ECC_ED25519) / Cloud HSM                    │
│  • Non-Exportable Private Key                               │
│  • IAM Policy: Limited to `kms:Sign` on specific Key ARN     │
│  • CloudTrail / Audit Logging for every signature           │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Provisioning & Configuration

### AWS KMS Provisioning (CLI)
```bash
aws kms create-key \
  --key-spec ECC_ED25519 \
  --key-usage SIGN_VERIFY \
  --description "ZKVote Production Relayer Key" \
  --tags TagKey=Application,TagValue=ZKVote
```

### Environment Variables
Configure the relayer environment without raw secret keys:
```ini
# Signer Mode: 'local' (development), 'aws_kms', 'gcp_kms', 'pkcs11'
RELAYER_SIGNER_TYPE=aws_kms
RELAYER_PUBLIC_KEY=GABCD1234567890EXAMPLEPUBLICKEY...
KMS_KEY_ID=arn:aws:kms:us-east-1:123456789012:key/abcdef-1234-5678
KMS_REGION=us-east-1
```

---

## 4. Key Rotation Procedure

1. **Provision New KMS Key:**
   - Create a secondary KMS key with the same IAM policy.
   - Fund the corresponding Stellar public key on-chain with base reserve & gas.
2. **Blue-Green Relayer Cutover:**
   - Update `KMS_KEY_ID` and `RELAYER_PUBLIC_KEY` in staging.
   - Verify transaction inclusion on Futurenet/Mainnet.
   - Roll out config to production relayer nodes.
3. **Deprecate Old Key:**
   - Drain remaining XLM from old address.
   - Schedule KMS key deletion after a 30-day grace period.

---

## 5. Emergency Incident Response

- **Suspected Host Compromise:**
  1. Immediately revoke IAM role or disable the KMS key in the cloud console:
     ```bash
     aws kms disable-key --key-id <KMS_KEY_ID>
     ```
  2. Because the private key was never exported or exportable, no key extraction took place.
  3. Deploy a fresh relayer node with a newly generated KMS key.
