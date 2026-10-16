# EPIC-009: Hardware and air-gapped voting

An air-gap ceremony has two explicit artifacts: an unsigned vote package created online and a signed package returned from the offline signer. Each package contains a protocol version, election and ballot digest, nonce, expiration, payload hash, and checksum. No private key, witness secret, or unnecessary voter identifier crosses the gap.

The offline device verifies the election digest, ballot choices, destination, and expiry on its trusted display before signing. The online side verifies the signature against the exact package digest and rejects replay, election mismatch, expiry, and post-signing mutation. QR transport uses numbered authenticated chunks; USB transport requires a checksum and malware-scanning handoff.

Hardware support is capability-based: the published matrix records signing support, display verification, transport restrictions, and recovery behavior per device. Failed or expired ceremonies can be resumed only by creating a new nonce-bound package. Telemetry records aggregate ceremony outcomes without retaining vote choices or wallet secrets.

