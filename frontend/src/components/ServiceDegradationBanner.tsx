import { useEffect, useState } from "react";
import {
  checkRelayerHealthDetails,
  subscribeToServiceDegradation,
  getDegradedServices,
  type HealthServicesSnapshot,
} from "../lib/api";

/**
 * Shows a non-blocking banner when the relayer reports degraded
 * non-critical / background services (#204).
 */
export function ServiceDegradationBanner() {
  const [services, setServices] = useState<string[]>(() => getDegradedServices());
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

  const labels = services
    .map((s) => s.replace(/_/g, " "))
    .join(", ");

  return (
    <div
      className="bg-amber-500/10 border border-amber-500/30 text-amber-100 px-4 py-2 text-sm flex items-center justify-between gap-3"
      role="status"
      data-testid="service-degradation-banner"
    >
      <span>
        Reduced functionality: {labels}. Core voting remains available
        {detail?.status === "degraded" ? " while auxiliary services recover" : ""}.
      </span>
    </div>
  );
}
