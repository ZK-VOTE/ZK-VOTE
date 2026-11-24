import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRouter, useSearchParams } from "next/navigation";

import CompareClient from "./CompareClient";
import { listPublicListings, type PropertyListing } from "@/lib/propertiesApi";

const { replaceMock, searchState } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  searchState: { query: "" },
}));

vi.mock("@/lib/propertiesApi", () => ({
  listPublicListings: vi.fn(),
}));

function listing(
  listingId: string,
  address: string,
  amenities: string[] = [],
): PropertyListing {
  return {
    listingId,
    whistleblowerId: "wb-1",
    address,
    area: "Lekki",
    city: "Lagos",
    bedrooms: 2,
    bathrooms: 1,
    annualRentNgn: 1_000_000,
    outrightPriceNgn: 50_000_000,
    installmentBasePriceNgn: 60_000_000,
    hasApprovedInspection: true,
    amenities,
    photos: [],
    status: "active",
    createdAt: "",
    updatedAt: "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  searchState.query = "";

  vi.mocked(useRouter).mockReturnValue({
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    push: vi.fn(),
    replace: replaceMock,
    prefetch: vi.fn(),
  });
  vi.mocked(useSearchParams).mockImplementation(
    () => new URLSearchParams(searchState.query) as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(listPublicListings).mockResolvedValue({
    success: true,
    data: [
      listing("L1", "12 Admiralty Way", ["parking"]),
      listing("L2", "5 Bourdillon Road", []),
    ],
    total: 2,
    page: 1,
    pageSize: 2,
    totalPages: 1,
  });
});

describe("CompareClient", () => {
  it("shows the under-minimum state without fetching or redirecting", async () => {
    searchState.query = "ids=L1";
    render(<CompareClient />);

    expect(await screen.findByText("Pick at least two properties")).toBeTruthy();
    expect(listPublicListings).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("parses the ids from the URL and renders each property as a column header", async () => {
    searchState.query = "ids=L1,L2";
    render(<CompareClient />);

    expect(await screen.findByRole("columnheader", { name: /12 admiralty way/i })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /5 bourdillon road/i })).toBeTruthy();
    expect(listPublicListings).toHaveBeenCalledWith(
      expect.objectContaining({ listingIds: ["L1", "L2"] }),
    );
  });

  it("removes a property and keeps the URL in sync", async () => {
    searchState.query = "ids=L1,L2";
    render(<CompareClient />);

    fireEvent.click(await screen.findByRole("button", { name: /remove 12 admiralty way/i }));

    expect(replaceMock).toHaveBeenCalledWith("/properties/compare?ids=L2");
  });

  it("highlights amenity rows where listings disagree", async () => {
    searchState.query = "ids=L1,L2";
    const { container } = render(<CompareClient />);
    await screen.findByRole("columnheader", { name: /12 admiralty way/i });

    await waitFor(() => {
      const differing = container.querySelectorAll("tr[data-differs]");
      expect(differing.length).toBe(1);
      expect(differing[0].textContent).toContain("Parking");
    });
  });
});
