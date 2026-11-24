import { useEffect, useState } from "react";
import {
  checkRelayerHealthDetails,
  describeDegradedSources,
  subscribeToServiceDegradation,
  getDegradedServices,
  type HealthServicesSnapshot,
} from "../lib/api";

/**
 * Shows a non-blocking banner when the relayer reports degraded
 * non-critical / background services (#204).
 */
export function ServiceDegradationBanner() {
  const [services, setServices] = useState<string[]>(() =>
    getDegradedServices(),
  );
  const [detail, setDetail] = useState<HealthServicesSnapshot | null>(null);

  useEffect(() => {
    const unsub = subscribeToServiceDegradation((list) => setServices(list));
    checkRelayerHealthDetails().then((snap) => {
      if (snap) {
        setDetail(snap);
        setServices(snap.degraded);
      }
    });
    const id = setInterval(() => {
      checkRelayerHealthDetails().then((snap) => {
        if (snap) {
          setDetail(snap);
          setServices(snap.degraded);
        }
      });
    }, 30_000);
    return () => {
      unsub();
      clearInterval(id);
    };
  }, []);

  if (services.length === 0) return null;

  // Upstream sources on vote/money paths get a specific impact message (#745);
  // anything else keeps the generic auxiliary-service line.
  const impacts = describeDegradedSources(services);
  const auxiliary = services.filter(
    (s) => !impacts.some((impact) => impact.service === s),
  );
  const votingAffected = impacts.some((i) => i.service === "soroban_rpc");
  const labels = auxiliary.map((s) => s.replace(/_/g, " ")).join(", ");

  return (
    <div
      className="bg-amber-500/10 border border-amber-500/30 text-amber-100 px-4 py-2 text-sm flex flex-col gap-1"
      role="status"
      data-testid="service-degradation-banner"
    >
      {impacts.map((impact) => (
        <span key={impact.service} data-testid={`degraded-source-${impact.service}`}>
          {impact.message}
        </span>
      ))}
      {auxiliary.length > 0 && (
        <span>
          Reduced functionality: {labels}.
          {votingAffected
            ? ""
            : ` Core voting remains available${
                detail?.status === "degraded"
                  ? " while auxiliary services recover"
                  : ""
              }.`}
        </span>
      )}
    </div>
  );
}
