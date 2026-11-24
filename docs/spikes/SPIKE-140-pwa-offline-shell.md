# SPIKE-140: PWA and Offline Shell Analysis

## Executive Summary

**Status**: Investigation Complete  
**Date**: October 15, 2026  
**Investigator**: d-plug

## Current State Assessment

### Existing Offline Capabilities

The app **already has** partial offline support, not "blank screens" on all offline loads:

1. **Offline Submission Queue** (`frontend/src/store/submissionQueue.ts`)
   - Durable localStorage-backed queue
   - Deduplication by nullifier
   - Status tracking: pending → submitting → submitted/failed/conflict
   - Exponential backoff with `retryAfter` timestamps
   - Encrypted payloads with `encryptData/decryptData`

2. **HTTP Caching Taxonomy** (`frontend/nginx.conf`)
   - Circuit artifacts: `try_files $uri =404`, immutable 1y cache
   - Static assets: 1y immutable cache
   - SPA fallback: `try_files $uri $uri/ /index.html`
   - Security headers: CSP, COOP+COEP for cross-origin isolation

3. **Online/Offline Detection** (`frontend/src/hooks/useSubmissionQueue.ts`)
   - `navigator.onLine` checks
   - Queue UI with roles: offline/pending/conflict/failure banners

### Critical Gap: No Service Worker

**ZERO PWA artifacts found:**

- No `manifest.json` or `manifest.webmanifest`
- No service worker registration script
- No Workbox plugin in `vite.config.ts`
- No app icons (`apple-touch-icon`, theme-color)
- No install prompt or PWA lifecycle management

**Consequence**: Cold offline load renders empty `#root` div. Offline queue only works for **already-loaded** apps going offline mid-session.

## Why This Is Extremely Hard

### The Mid-Vote Update Safety Problem

**Consensus-Critical Bug**: A service worker that updates mid-vote can destroy votes, not just delay them.

**Attack Scenario:**

1. User starts multi-minute proving flow (`VoteModal.tsx:276-280`)
2. New app version pushed to CDN → service worker receives `updatefound` event
3. If SW does `skipWaiting()`, new code activates immediately
4. New `/circuits/verification_key.json` or prover WASM swapped mid-proof
5. Proof valid under **old VK** but rejected by **new contract VK**
6. **Nullifier already consumed client-side** → vote destroyed, not retryable

**Safety Requirement**: Update lock that prevents SW activation during active vote transactions.

### Cache Forensics Risk

Service worker `CacheStorage` persists:

- Visited DAO URLs
- Partial vote payloads (if `Request` cache includes POST bodies)
- Merkle tree data
- User navigation patterns

**Privacy Requirement**: Cache partitioning with forensics-tested eviction per SPIKE-083/129 methods.

## Tier-1 Adversarial Extension

### Attack: Push-During-Proving

**Exploit**: Attacker with CDN push access forces app update mid-proof.

**Impact**:

- Proof generated with old circuit → fails verification with new VK
- Nullifier consumed (client-side state) but vote never landed on-chain
- User cannot revote (nullifier already used in queue)
- Vote **permanently lost**, not just delayed

**Defense**:

1. Version-pinned update lock scoped to vote transaction
2. SW activation only on drained queues
3. Kill-switch with proven non-bricking recovery

### Cache Forensics

**Evidence Leak**: Cached DAOs, proposals, membership tree nodes.

**Attack**: Device seizure + cache extraction → voting history reconstruction.

**Defense**:

- Never cache: secrets, intents, nullifiers, vote payloads
- Shell/API/keys: separate cache buckets with different eviction
- Forensics drill: extract cache, attempt voting history reconstruction, measure success rate

## Recommendations

### Phase 1: Service Worker Foundation (24h)

1. **Add Workbox to Vite Config**

   ```typescript
   // frontend/vite.config.ts
   import { VitePWA } from "vite-plugin-pwa";

   plugins: [
     react(),
     VitePWA({
       registerType: "prompt", // User-visible refresh, never silent
       workbox: {
         // Shell: aggressive cache
         runtimeCaching: [
           {
             urlPattern: /^https?:\/\/[^/]+\/(index\.html|$)/,
             handler: "NetworkFirst",
             options: { cacheName: "shell-v1" },
           },
           // API: network-first with freshness
           {
             urlPattern: /\/api\//,
             handler: "NetworkFirst",
             options: {
               cacheName: "api-v1",
               expiration: { maxAgeSeconds: 300 },
             },
           },
           // Circuit keys: versioned immutable
           {
             urlPattern: /\/circuits\//,
             handler: "CacheFirst",
             options: {
               cacheName: "circuits-v1",
               expiration: { maxAgeSeconds: 31536000 },
             },
           },
         ],
         // NEVER cache these
         navigateFallbackDenylist: [/\/api\//, /\/circuits\//],
       },
       manifest: {
         name: "ZK-VOTE Governance",
         short_name: "ZK-VOTE",
         description: "Zero-knowledge voting for DAOs",
         theme_color: "#000000",
         icons: [
           { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
           { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
         ],
       },
     }),
   ];
   ```

2. **Mid-Vote Update Lock**

   ```typescript
   // frontend/src/lib/serviceWorkerUpdate.ts
   export function lockUpdates(voteTransactionId: string) {
     localStorage.setItem("sw_update_lock", voteTransactionId);
   }

   export function unlockUpdates() {
     localStorage.removeItem("sw_update_lock");
   }

   export function isUpdateLocked(): boolean {
     return localStorage.getItem("sw_update_lock") !== null;
   }

   // In service worker:
   self.addEventListener("message", (event) => {
     if (event.data.type === "CHECK_UPDATE_LOCK") {
       event.ports[0].postMessage({ locked: isUpdateLocked() });
     }
   });

   self.addEventListener("install", (event) => {
     // NEW: Do not skipWaiting() if update is locked
     event.waitUntil(
       checkUpdateLock().then((locked) => {
         if (!locked) {
           return self.skipWaiting();
         }
       }),
     );
   });
   ```

3. **Update Prompt UI**
   ```tsx
   // frontend/src/components/UpdatePrompt.tsx
   export function UpdatePrompt() {
     const [updateAvailable, setUpdateAvailable] = useState(false);
     const [locked, setLocked] = useState(false);

     useEffect(() => {
       const wb = new Workbox("/sw.js");
       wb.addEventListener("waiting", () => {
         setUpdateAvailable(true);
         setLocked(isUpdateLocked());
       });
       wb.register();
     }, []);

     const handleUpdate = () => {
       if (locked) {
         alert("Update blocked: vote in progress. Complete vote first.");
         return;
       }
       // Trigger update
       wb.messageSkipWaiting();
       window.location.reload();
     };

     return updateAvailable ? (
       <div className="update-prompt">
         <p>New version available</p>
         <button onClick={handleUpdate} disabled={locked}>
           {locked ? "Vote in progress..." : "Update now"}
         </button>
       </div>
     ) : null;
   }
   ```

### Phase 2: Caching Taxonomy (24h)

4. **Cache Partitioning**
   - **shell-v1**: index.html, core JS/CSS (aggressive cache)
   - **api-v1**: API responses (network-first, 5min TTL)
   - **circuits-v1**: .wasm/.zkey (immutable, 1y)
   - **never-cache**: No cache directive for `/api/v1/vote`, `/api/v1/proofs`

5. **Cache Forensics Testing**
   ```typescript
   // tests/e2e/cache-forensics.spec.ts
   test("cache does not persist vote secrets", async ({ page }) => {
     await page.goto("/dao/1/proposal/1");
     await page.fill("#secret", "test-secret-12345");
     await page.click('[data-testid="vote-submit"]');
     await page.waitForTimeout(2000);

     // Extract all cache storage
     const caches = await page.evaluate(async () => {
       const cacheNames = await caches.keys();
       const allCaches = [];
       for (const name of cacheNames) {
         const cache = await caches.open(name);
         const requests = await cache.keys();
         allCaches.push({ name, requests: requests.map((r) => r.url) });
       }
       return allCaches;
     });

     // Assert: no cache contains the secret
     const allUrls = caches.flatMap((c) => c.requests).join(" ");
     expect(allUrls).not.toContain("test-secret-12345");
   });
   ```

### Phase 3: Kill-Switch & Recovery (48h)

6. **Kill-Switch Implementation**

   ```typescript
   // frontend/public/kill-switch.json (served from CDN)
   {
     "version": 1,
     "disableSW": false,
     "forceReload": false
   }

   // In service worker:
   self.addEventListener('fetch', async (event) => {
     const killSwitch = await fetch('/kill-switch.json').then(r => r.json());
     if (killSwitch.disableSW) {
       return; // Bypass SW, fallback to network
     }
     // Normal caching logic...
   });
   ```

7. **Kill-Switch Drill**
   ```bash
   # scripts/test/drill-kill-switch.sh
   echo '{"version":1,"disableSW":true,"forceReload":true}' > frontend/public/kill-switch.json
   # Deploy to CDN
   # Test: all cached clients should bypass SW and reload within 5 minutes
   ```

## Edge Caching Configuration

### Cloudflare Workers (`frontend/wrangler.toml`)

```toml
[site]
bucket = "./dist"

[[rules]]
# Immutable circuit artifacts
pattern = "/circuits/*"
cache_level = "everything"
edge_cache_ttl = 31536000

[[rules]]
# App shell with version fingerprint
pattern = "/assets/*"
cache_level = "everything"
edge_cache_ttl = 31536000

[[rules]]
# HTML with SW lifecycle
pattern = "/"
cache_level = "bypass"
```

### Fly.io (`frontend/fly.toml`)

```toml
[[services.http_checks]]
interval = 10000
timeout = 2000
path = "/health"

[[services]]
  protocol = "tcp"
  internal_port = 8080

  [[services.http_options.response.headers]]
    [services.http_options.response.headers."circuits/*"]
      "Cache-Control" = "public, max-age=31536000, immutable"

    [services.http_options.response.headers."/"]
      "Cache-Control" = "no-cache"
```

## Acceptance Criteria Status

| Criterion                   | Status     | Evidence                                                 |
| --------------------------- | ---------- | -------------------------------------------------------- |
| Offline shell loads         | ❌ FAIL    | No service worker → blank screen on cold offline load    |
| Updates never corrupt votes | ❌ FAIL    | No mid-vote update lock                                  |
| Cache forensically clean    | ⚠️ PARTIAL | No SW yet, but offline queue encrypts payloads           |
| Installability shipped      | ❌ FAIL    | No manifest.json                                         |
| Edge caching configured     | ⚠️ PARTIAL | Nginx config exists; wrangler.toml/fly.toml unconfigured |

## Tier-1 Additions

| Criterion                                         | Status  |
| ------------------------------------------------- | ------- |
| Update lock enforced (tested push-during-proving) | ❌ TODO |
| Kill-switch drilled on cached clients             | ❌ TODO |
| Cache taxonomy with privacy review                | ❌ TODO |

## References

- Issue: https://github.com/ZK-VOTE/ZK-VOTE/issues/794
- Offline queue: `frontend/src/store/submissionQueue.ts`
- Nginx config: `frontend/nginx.conf`
- Vite config: `frontend/vite.config.ts`
