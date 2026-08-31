import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import DAOInfoPanel from "./DAOInfoPanel";

const mockGetDao = vi.fn();
const mockGetMemberCount = vi.fn();
const mockGetTreeInfo = vi.fn();
const mockVkVersion = vi.fn();

vi.mock("../lib/readOnlyContracts", () => ({
  getReadOnlyDaoRegistry: () => ({
    get_dao: mockGetDao,
  }),
  getReadOnlyMembershipSbt: () => ({
    get_member_count: mockGetMemberCount,
  }),
  getReadOnlyMembershipTree: () => ({
    get_tree_info: mockGetTreeInfo,
  }),
  getReadOnlyVoting: () => ({
    vk_version: mockVkVersion,
    vk_for_version: vi.fn(),
  }),
}));

vi.mock("../lib/client", () => ({
  getZkVoteClient: vi.fn(),
}));

describe("DAOInfoPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rootHistoryLen: 27, anonymitySetSize: 42 }),
    } as Response);
    mockGetDao.mockResolvedValue({
      result: {
        name: "Test DAO",
        admin: "GDADMIN123456789012345678901234567890123456789",
        membership_open: true,
        members_can_propose: true,
        metadata_cid: null,
      },
    });
    mockGetMemberCount.mockResolvedValue({ result: BigInt(42) });
    mockGetTreeInfo.mockResolvedValue({
      result: [18, 42, BigInt("1234567890")],
    });
    mockVkVersion.mockResolvedValue({ result: BigInt(1) });
  });

  it("shows the anonymity set and eviction warning when roots approach the cap", async () => {
    render(<DAOInfoPanel daoId={1} publicKey={null} kit={null} />);

    expect(await screen.findByText("Anonymity Set")).toBeInTheDocument();
    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(
      await screen.findByText(/Root history is nearing eviction|near MAX_ROOTS/i),
    ).toBeInTheDocument();
  });
});
