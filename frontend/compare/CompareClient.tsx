"use client";

/**
 * Side-by-side property comparison (#1916).
 *
 * The selection lives in the `ids` query string, so a comparison can be shared
 * and survives reloads. It is also mirrored to session storage, so returning to
 * the page without ids restores the last selection. Removing a property updates
 * both. Amenity rows where listings disagree are highlighted.
 */

import { Suspense, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Bath, Bed, Home, MapPin, Scale, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState, MoneyValue } from "@/components/ui/data-state";
import { Skeleton } from "@/components/ui/skeleton";
import { listPublicListings, type PropertyListing } from "@/lib/propertiesApi";
import { formatNgn } from "@/lib/currency";
import { PROPERTY_AMENITY_LABELS, type PropertyAmenity } from "@/lib/amenities";
import {
  MAX_COMPARE,
  MIN_COMPARE,
  buildAmenityDiff,
  encodeCompareIds,
  loadCompareIds,
  parseCompareIds,
  removeFromCompare,
  saveCompareIds,
} from "@/lib/compare";

/** Listing payloads carry the annual rent; the instalment is spread over this many months. */
const PLAN_MONTHS = 12;

type Fetched = {
  key: string;
  reload: number;
  listings?: PropertyListing[];
  error?: string;
};

function formatLocation(listing: PropertyListing) {
  const parts = [listing.area, listing.city].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "Nigeria";
}

function amenityLabel(amenity: string) {
  return PROPERTY_AMENITY_LABELS[amenity as PropertyAmenity] ?? amenity;
}

function CompareContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const ids = parseCompareIds(searchParams.get("ids"));
  const key = ids.join(",");
  const [reload, setReload] = useState(0);
  const [fetched, setFetched] = useState<Fetched | null>(null);

  // Restore the last selection from this session when the page opens without one.
  // Runs on mount only: once the user has removed everything, it must not bring the old set back.
  useEffect(() => {
    if (ids.length > 0) return;
    const stored = loadCompareIds();
    if (stored.length > 0) {
      router.replace(`/properties/compare?ids=${encodeCompareIds(stored)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the session copy in step with the URL, so the selection can be restored later.
  useEffect(() => {
    if (key) saveCompareIds(key.split(","));
  }, [key]);

  useEffect(() => {
    const requested = key ? key.split(",") : [];
    // Do not fetch a comparison until the selection meets the minimum. In particular,
    // one selected id is a valid under-minimum state, not a reason to redirect or fetch.
    if (requested.length < MIN_COMPARE) return;

    let cancelled = false;
    listPublicListings({ listingIds: requested, pageSize: requested.length })
      .then((res) => {
        if (cancelled) return;
        const byId = new Map(res.data.map((listing) => [listing.listingId, listing]));
        const listings = requested
          .map((id) => byId.get(id))
          .filter((listing): listing is PropertyListing => listing !== undefined);
        setFetched({ key, reload, listings });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFetched({
            key,
            reload,
            error: err instanceof Error ? err.message : "Could not load these properties.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key, reload]);

  const removeListing = (listingId: string) => {
    const next = removeFromCompare(ids, listingId);
    saveCompareIds(next);
    router.replace(next.length > 0 ? `/properties/compare?ids=${encodeCompareIds(next)}` : "/properties/compare");
  };

  const retry = () => setReload((n) => n + 1);

  const underMinimum = ids.length < MIN_COMPARE;
  const current = fetched && fetched.key === key && fetched.reload === reload ? fetched : null;
  const listings = current?.listings;
  const error = current?.error;

  return (
    <main className="min-h-screen bg-background">
      <section className="container mx-auto px-4 py-12">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black tracking-tight">Compare properties</h1>
            <p className="mt-2 text-muted-foreground">
              Compare {MIN_COMPARE} to {MAX_COMPARE} homes side by side.
            </p>
          </div>
          <Button asChild variant="outline" className="border-2 border-foreground font-bold">
            <Link href="/properties">Back to search</Link>
          </Button>
        </header>

        {underMinimum && (
          <EmptyState
            icon={Scale}
            title="Pick at least two properties"
            description={`You have ${ids.length} selected. Tap the compare icon on at least ${MIN_COMPARE} listings to see them side by side.`}
            action={{ label: "Browse properties", href: "/properties" }}
          />
        )}

        {!underMinimum && !listings && !error && (
          <LoadingState label="Loading comparison" className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {ids.map((id) => (
              <Skeleton key={id} className="h-80 w-full" />
            ))}
          </LoadingState>
        )}

        {!underMinimum && error && (
          <ErrorState title="The comparison is unavailable" description={error} onRetry={retry} />
        )}

        {!underMinimum && listings && listings.length < MIN_COMPARE && (
          <EmptyState
            icon={Home}
            title="Not enough of these listings are available"
            description="Some of the selected properties could not be found. Remove them or pick others from search."
            action={{ label: "Browse properties", href: "/properties" }}
          />
        )}

        {!underMinimum && listings && listings.length >= MIN_COMPARE && (
          <ComparisonTable listings={listings} onRemove={removeListing} />
        )}
      </section>
    </main>
  );
}

function ComparisonTable({
  listings,
  onRemove,
}: {
  listings: PropertyListing[];
  onRemove: (listingId: string) => void;
}) {
  const amenityRows = buildAmenityDiff(listings.map((l) => ({ amenities: l.amenities ?? [] })));
  const cellClass = "border-t-2 border-foreground/20 p-3 align-top";
  const headClass = "border-t-2 border-foreground/20 p-3 text-left align-top text-sm font-medium text-muted-foreground";

  return (
    <div className="overflow-x-auto border-3 border-foreground bg-card">
      <table className="w-full min-w-160 border-collapse">
        <caption className="sr-only">
          Comparison of {listings.length} properties on price, instalments, location, bedrooms, verification and amenities
        </caption>
        <thead>
          <tr>
            <td className="w-40 p-3" />
            {listings.map((listing) => (
              <th key={listing.listingId} scope="col" className="p-3 text-left align-top">
                <div className="space-y-2">
                  <div className="relative aspect-4/3 w-full overflow-hidden border-2 border-foreground bg-muted">
                    {listing.photos?.[0] ? (
                      <Image
                        src={listing.photos[0]}
                        alt={`Photo of ${listing.address}`}
                        fill
                        sizes="(max-width: 768px) 80vw, 33vw"
                        className="object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                        <Home className="h-10 w-10" aria-hidden="true" />
                        <span className="sr-only">No photo available</span>
                      </div>
                    )}
                  </div>
                  <p className="font-mono text-base font-bold leading-tight">{listing.address}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRemove(listing.listingId)}
                    aria-label={`Remove ${listing.address} from comparison`}
                    className="-ml-2 gap-1"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                    Remove
                  </Button>
                </div>
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          <tr>
            <th scope="row" className={headClass}>Price</th>
            {listings.map((l) => (
              <td key={l.listingId} className={cellClass}>
                <p className="font-mono text-lg font-black">
                  <MoneyValue
                    status="ready"
                    amount={l.outrightPriceNgn ?? l.installmentBasePriceNgn}
                    format={formatNgn}
                    unavailableLabel="Price unavailable"
                  />
                </p>
                <p className="text-xs text-muted-foreground">
                  {l.outrightPriceNgn ? "Outright" : "Installment base"}
                </p>
              </td>
            ))}
          </tr>

          <tr>
            <th scope="row" className={headClass}>Annual rent</th>
            {listings.map((l) => (
              <td key={l.listingId} className={cellClass}>
                <MoneyValue status="ready" amount={l.annualRentNgn} format={formatNgn} unavailableLabel="Rent unavailable" />
              </td>
            ))}
          </tr>

          <tr>
            <th scope="row" className={headClass}>Monthly instalment</th>
            {listings.map((l) => (
              <td key={l.listingId} className={cellClass}>
                <MoneyValue
                  status="ready"
                  amount={
                    l.installmentBasePriceNgn !== undefined
                      ? Math.round(l.installmentBasePriceNgn / PLAN_MONTHS)
                      : undefined
                  }
                  format={formatNgn}
                  unavailableLabel="Not offered on instalments"
                />
                <span className="text-xs text-muted-foreground"> / month, {PLAN_MONTHS}-month plan</span>
              </td>
            ))}
          </tr>

          <tr>
            <th scope="row" className={headClass}>Deposit</th>
            {listings.map((l) => (
              <td key={l.listingId} className={cellClass}>
                <span className="text-muted-foreground">Not listed</span>
              </td>
            ))}
          </tr>

          <tr>
            <th scope="row" className={headClass}>Location</th>
            {listings.map((l) => (
              <td key={l.listingId} className={cellClass}>
                <span className="flex items-center gap-1">
                  <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {formatLocation(l)}
                </span>
              </td>
            ))}
          </tr>

          <tr>
            <th scope="row" className={headClass}>Bedrooms and bathrooms</th>
            {listings.map((l) => (
              <td key={l.listingId} className={cellClass}>
                <span className="flex items-center gap-3">
                  <span className="flex items-center gap-1">
                    <Bed className="h-4 w-4" aria-hidden="true" />
                    {l.bedrooms} bed
                  </span>
                  <span className="flex items-center gap-1">
                    <Bath className="h-4 w-4" aria-hidden="true" />
                    {l.bathrooms} bath
                  </span>
                </span>
              </td>
            ))}
          </tr>

          <tr>
            <th scope="row" className={headClass}>Verification</th>
            {listings.map((l) => (
              <td key={l.listingId} className={cellClass}>
                {l.hasApprovedInspection ? (
                  <span className="flex items-center gap-1 font-medium">
                    <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                    Verified inspection
                  </span>
                ) : (
                  <span className="text-muted-foreground">No approved inspection</span>
                )}
              </td>
            ))}
          </tr>

          {amenityRows.length === 0 && (
            <tr>
              <th scope="row" className={headClass}>Amenities</th>
              <td className={cellClass} colSpan={listings.length}>
                <span className="text-muted-foreground">No amenities listed for these properties.</span>
              </td>
            </tr>
          )}

          {amenityRows.map((row) => (
            <tr key={row.amenity} data-differs={row.differs || undefined} className={row.differs ? "bg-primary/10" : undefined}>
              <th scope="row" className={headClass}>
                {amenityLabel(row.amenity)}
                {row.differs && <span className="sr-only"> (differs between properties)</span>}
              </th>
              {row.availability.map((has, index) => (
                <td key={listings[index].listingId} className={cellClass}>
                  {has ? (
                    <span className="font-bold">Included</span>
                  ) : (
                    <span className="text-muted-foreground">Not included</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CompareClient() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-background flex items-center justify-center">
          <p className="font-mono font-bold text-muted-foreground">Loading comparison...</p>
        </main>
      }
    >
      <CompareContent />
    </Suspense>
  );
}
