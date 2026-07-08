import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ManageMembers from "./ManageMembers";

// Mock the hooks and libraries
vi.mock("../hooks/useWallet", () => ({
  useWallet: vi.fn(() => ({
    kit: {
      signMessage: vi
        .fn()
        .mockResolvedValue({ signedMessage: "mocked-signature" }),
      signTransaction: vi.fn(),
    },
  })),
}));

vi.mock("../lib/contracts", () => ({
  initializeContractClients: vi.fn(() => ({
    membershipSbt: {
      has: vi.fn().mockResolvedValue({ result: false }),
      mint: vi.fn().mockResolvedValue({
        signAndSend: vi.fn().mockResolvedValue({ hash: "tx123" }),
      }),
      get_member_count: vi.fn().mockResolvedValue({ result: BigInt(2) }),
      get_members: vi.fn().mockResolvedValue({
        result: ["GABC...", "GDEF..."],
      }),
      get_alias: vi.fn().mockResolvedValue({ result: null }),
      revoke: vi.fn().mockResolvedValue({
        signAndSend: vi.fn().mockResolvedValue({ hash: "tx456" }),
      }),
      leave: vi.fn().mockResolvedValue({
        signAndSend: vi.fn().mockResolvedValue({ hash: "tx789" }),
      }),
      update_alias: vi.fn().mockResolvedValue({
        signAndSend: vi.fn().mockResolvedValue({ hash: "tx101" }),
      }),
    },
    membershipTree: {
      get_tree_info: vi.fn().mockResolvedValue({
        result: [18, 2, BigInt("12345678901234567890")],
      }),
      remove_member: vi.fn().mockResolvedValue({
        signAndSend: vi.fn().mockResolvedValue({ hash: "tx112" }),
      }),
    },
    daoRegistry: {
      get_dao: vi.fn().mockResolvedValue({
        result: { admin: "GADMIN..." },
      }),
    },
    voting: {
      vk_version: vi.fn().mockResolvedValue({ result: 1 }),
    },
  })),
}));

vi.mock("../lib/readOnlyContracts", () => ({
  getReadOnlyDaoRegistry: vi.fn(() => ({
    get_dao: vi.fn().mockResolvedValue({
      result: { admin: "GADMIN..." },
    }),
  })),
  getReadOnlyMembershipSbt: vi.fn(() => ({
    get_member_count: vi.fn().mockResolvedValue({ result: BigInt(2) }),
    get_members: vi.fn().mockResolvedValue({
      result: ["GABC123456789...", "GDEF987654321..."],
    }),
    has: vi.fn().mockResolvedValue({ result: true }),
    get_alias: vi.fn().mockResolvedValue({ result: null }),
  })),
  getReadOnlyMembershipTree: vi.fn(() => ({
    get_tree_info: vi.fn().mockResolvedValue({
      result: [18, 2, BigInt("12345678901234567890")],
    }),
  })),
  getReadOnlyVoting: vi.fn(() => ({
    vk_version: vi.fn().mockResolvedValue({ result: 1 }),
  })),
}));

vi.mock("../lib/encryption", () => ({
  getOrDeriveEncryptionKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
  encryptAlias: vi.fn().mockReturnValue("encrypted-alias"),
  decryptAlias: vi.fn().mockReturnValue("decrypted-alias"),
}));

vi.mock("../lib/api", () => ({
  notifyEvent: vi.fn(),
}));

vi.mock("../lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/utils")>();
  return {
    ...actual,
    truncateAddress: vi.fn(
      (addr: string, start = 4, end = 4) =>
        `${addr.slice(0, start)}...${addr.slice(-end)}`,
    ),
    extractTxHash: vi.fn().mockReturnValue("txhash123"),
  };
});

describe("ManageMembers", () => {
  const defaultProps = {
    publicKey: "GPUBLIC...",
    daoId: 1,
    isAdmin: false,
    isInitializing: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe("Rendering", () => {
    it("renders loading state initially when no cache", () => {
      render(<ManageMembers {...defaultProps} />);

      // Should show loading spinner when no cached data
      const spinner = document.querySelector(".animate-spin");
      expect(spinner).toBeTruthy();
    });

    it("renders statistics dashboard when data loads", async () => {
      render(<ManageMembers {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("Merkle Tree Depth")).toBeInTheDocument();
      });

      expect(screen.getByText("Registered Voters")).toBeInTheDocument();
      expect(screen.getByText("Tree Capacity")).toBeInTheDocument();
      expect(screen.getByText("Verifying Key Version")).toBeInTheDocument();
    });

    it("shows current merkle root section", async () => {
      render(<ManageMembers {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("Current Merkle Root")).toBeInTheDocument();
      });
    });

    it("shows current members section", async () => {
      render(<ManageMembers {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/Current Members/)).toBeInTheDocument();
      });
    });
  });

  describe("Admin Features", () => {
    const adminProps = {
      ...defaultProps,
      isAdmin: true,
    };

    it("shows mint SBT form for admin", async () => {
      render(<ManageMembers {...adminProps} />);

      await waitFor(() => {
        expect(screen.getByText("Mint Membership SBT")).toBeInTheDocument();
      });

      expect(screen.getByText("Recipient Address")).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText(/G\.\.\. \(Stellar address\)/),
      ).toBeInTheDocument();
    });

    it("hides mint SBT form for non-admin", async () => {
      render(<ManageMembers {...defaultProps} isAdmin={false} />);

      await waitFor(() => {
        expect(screen.getByText(/Current Members/)).toBeInTheDocument();
      });

      expect(screen.queryByText("Mint Membership SBT")).not.toBeInTheDocument();
    });

    it("shows action menu for non-admin members when admin", async () => {
      const { getReadOnlyMembershipSbt } =
        await import("../lib/readOnlyContracts");
      (getReadOnlyMembershipSbt as ReturnType<typeof vi.fn>).mockReturnValue({
        get_member_count: vi.fn().mockResolvedValue({ result: BigInt(1) }),
        get_members: vi.fn().mockResolvedValue({
          result: ["GOTHER..."],
        }),
        has: vi.fn().mockResolvedValue({ result: true }),
        get_alias: vi.fn().mockResolvedValue({ result: null }),
      });

      render(<ManageMembers {...adminProps} />);

      await waitFor(() => {
        // Look for the member actions menu button (three dots icon)
        const actionButtons = document.querySelectorAll(
          '[title="Member actions"]',
        );
        expect(actionButtons.length).toBeGreaterThan(0);
      });
    });
  });

  describe("Mint SBT", () => {
    const adminProps = {
      ...defaultProps,
      isAdmin: true,
    };

    it("disables mint button when address is empty", async () => {
      render(<ManageMembers {...adminProps} />);

      await waitFor(() => {
        expect(screen.getByText("Mint SBT")).toBeInTheDocument();
      });

      const mintButton = screen.getByText("Mint SBT");
      expect(mintButton).toBeDisabled();
    });

    it("enables mint button when address is entered", async () => {
      render(<ManageMembers {...adminProps} />);

      await waitFor(() => {
        expect(screen.getByText("Mint SBT")).toBeInTheDocument();
      });

      const addressInput = screen.getByPlaceholderText(
        /G\.\.\. \(Stellar address\)/,
      );
      fireEvent.change(addressInput, { target: { value: "GNEWMEMBER..." } });

      const mintButton = screen.getByText("Mint SBT");
      expect(mintButton).not.toBeDisabled();
    });

    it("shows member alias input field", async () => {
      render(<ManageMembers {...adminProps} />);

      await waitFor(() => {
        expect(screen.getByText("Member Alias (Optional)")).toBeInTheDocument();
      });
    });
  });

  describe("Leave DAO", () => {
    it("shows leave button for non-admin members", async () => {
      const { getReadOnlyMembershipSbt } =
        await import("../lib/readOnlyContracts");
      (getReadOnlyMembershipSbt as ReturnType<typeof vi.fn>).mockReturnValue({
        get_member_count: vi.fn().mockResolvedValue({ result: BigInt(1) }),
        get_members: vi.fn().mockResolvedValue({
          result: ["GPUBLIC..."], // Same as publicKey
        }),
        has: vi.fn().mockResolvedValue({ result: true }),
        get_alias: vi.fn().mockResolvedValue({ result: null }),
      });

      render(<ManageMembers {...defaultProps} isAdmin={false} />);

      await waitFor(() => {
        const leaveButton = screen.queryByText("Leave");
        expect(leaveButton).toBeInTheDocument();
      });
    });
  });

  describe("Error Handling", () => {
    it("displays error message when operation fails", async () => {
      const { initializeContractClients } = await import("../lib/contracts");
      (initializeContractClients as ReturnType<typeof vi.fn>).mockReturnValue({
        membershipSbt: {
          has: vi.fn().mockRejectedValue(new Error("Network error")),
          mint: vi.fn().mockRejectedValue(new Error("Transaction failed")),
        },
        membershipTree: {
          get_tree_info: vi.fn().mockResolvedValue({
            result: [18, 2, BigInt("12345678901234567890")],
          }),
        },
        daoRegistry: {
          get_dao: vi.fn().mockResolvedValue({
            result: { admin: "GADMIN..." },
          }),
        },
        voting: {
          vk_version: vi.fn().mockResolvedValue({ result: 1 }),
        },
      });

      render(<ManageMembers {...defaultProps} isAdmin={true} />);

      await waitFor(() => {
        expect(screen.getByText("Mint SBT")).toBeInTheDocument();
      });

      // Enter an address and try to mint
      const addressInput = screen.getByPlaceholderText(
        /G\.\.\. \(Stellar address\)/,
      );
      fireEvent.change(addressInput, { target: { value: "GTEST..." } });

      const mintButton = screen.getByText("Mint SBT");
      fireEvent.click(mintButton);

      await waitFor(() => {
        // Error should be displayed
        const errorElement = screen.queryByText(/error|failed/i);
        expect(errorElement).toBeInTheDocument();
      });
    });
  });

  describe("Data Loading", () => {
    it("displays tree statistics after data loads", async () => {
      render(<ManageMembers {...defaultProps} />);

      // Wait for data to load
      await waitFor(() => {
        expect(screen.getByText("Merkle Tree Depth")).toBeInTheDocument();
      });

      // Should display tree depth from mock (18)
      expect(screen.getByText("18")).toBeInTheDocument();

      // Should display leaf count from mock (2)
      expect(screen.getByText("2")).toBeInTheDocument();
    });
  });

  describe("Wallet Initialization", () => {
    it("waits for wallet initialization when isInitializing is true", () => {
      render(<ManageMembers {...defaultProps} isInitializing={true} />);

      // Should not immediately try to load data
      // The loading state should be shown
      expect(screen.queryByText("Merkle Tree Depth")).not.toBeInTheDocument();
    });
  });
});

describe("ManageMembers Reinstate Member", () => {
  const adminProps = {
    publicKey: "GPUBLIC...",
    daoId: 1,
    isAdmin: true,
    isInitializing: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("renders member list for admin to manage", async () => {
    const { getReadOnlyMembershipSbt } =
      await import("../lib/readOnlyContracts");
    (getReadOnlyMembershipSbt as ReturnType<typeof vi.fn>).mockReturnValue({
      get_member_count: vi.fn().mockResolvedValue({ result: BigInt(1) }),
      get_members: vi.fn().mockResolvedValue({
        result: ["GREVOKED..."],
      }),
      has: vi.fn().mockResolvedValue({ result: false }), // Member was revoked
      get_alias: vi.fn().mockResolvedValue({ result: null }),
    });

    render(<ManageMembers {...adminProps} />);

    // Verify member list section renders
    await waitFor(() => {
      expect(screen.getByText(/Current Members/)).toBeInTheDocument();
    });
  });
});

describe("ManageMembers Alias Handling", () => {
  const defaultProps = {
    publicKey: "GPUBLIC...",
    daoId: 1,
    isAdmin: false,
    isInitializing: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("renders member list with aliases", async () => {
    const { getReadOnlyMembershipSbt } =
      await import("../lib/readOnlyContracts");

    (getReadOnlyMembershipSbt as ReturnType<typeof vi.fn>).mockReturnValue({
      get_member_count: vi.fn().mockResolvedValue({ result: BigInt(1) }),
      get_members: vi.fn().mockResolvedValue({
        result: ["GMEMBER..."],
      }),
      has: vi.fn().mockResolvedValue({ result: true }),
      get_alias: vi.fn().mockResolvedValue({ result: "encrypted-alias-data" }),
    });

    render(<ManageMembers {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/Current Members/)).toBeInTheDocument();
    });
  });

  it("handles null aliases gracefully", async () => {
    const { getReadOnlyMembershipSbt } =
      await import("../lib/readOnlyContracts");

    (getReadOnlyMembershipSbt as ReturnType<typeof vi.fn>).mockReturnValue({
      get_member_count: vi.fn().mockResolvedValue({ result: BigInt(2) }),
      get_members: vi.fn().mockResolvedValue({
        result: ["GMEMBER1...", "GMEMBER2..."],
      }),
      has: vi.fn().mockResolvedValue({ result: true }),
      get_alias: vi.fn().mockResolvedValue({ result: null }), // No alias set
    });

    render(<ManageMembers {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/Current Members/)).toBeInTheDocument();
    });
  });
});

describe("ManageMembers Data Refresh", () => {
  const adminProps = {
    publicKey: "GPUBLIC...",
    daoId: 1,
    isAdmin: true,
    isInitializing: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("calls get_members on initial load", async () => {
    const getMembersMock = vi
      .fn()
      .mockResolvedValue({ result: ["GEXISTING..."] });

    const { getReadOnlyMembershipSbt } =
      await import("../lib/readOnlyContracts");
    (getReadOnlyMembershipSbt as ReturnType<typeof vi.fn>).mockReturnValue({
      get_member_count: vi.fn().mockResolvedValue({ result: BigInt(1) }),
      get_members: getMembersMock,
      has: vi.fn().mockResolvedValue({ result: true }),
      get_alias: vi.fn().mockResolvedValue({ result: null }),
    });

    render(<ManageMembers {...adminProps} />);

    await waitFor(() => {
      expect(screen.getByText(/Current Members/)).toBeInTheDocument();
    });

    // Verify get_members was called at least once during initial load
    expect(getMembersMock).toHaveBeenCalled();
  });
});

describe("ManageMembers Confirmation Modals", () => {
  const adminProps = {
    publicKey: "GPUBLIC...",
    daoId: 1,
    isAdmin: true,
    isInitializing: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("shows revoke confirmation modal when clicking remove", async () => {
    const { getReadOnlyMembershipSbt } =
      await import("../lib/readOnlyContracts");
    (getReadOnlyMembershipSbt as ReturnType<typeof vi.fn>).mockReturnValue({
      get_member_count: vi.fn().mockResolvedValue({ result: BigInt(1) }),
      get_members: vi.fn().mockResolvedValue({
        result: ["GOTHER..."],
      }),
      has: vi.fn().mockResolvedValue({ result: true }),
      get_alias: vi.fn().mockResolvedValue({ result: null }),
    });

    render(<ManageMembers {...adminProps} />);

    await waitFor(() => {
      const actionButtons = document.querySelectorAll(
        '[title="Member actions"]',
      );
      expect(actionButtons.length).toBeGreaterThan(0);
    });

    // Click the actions menu button (three dots)
    const actionButton = document.querySelector('[title="Member actions"]');
    if (actionButton) {
      fireEvent.click(actionButton);
    }

    // Wait for dropdown menu to appear and click Remove Member
    await waitFor(() => {
      expect(screen.getByText("Remove Member")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Remove Member"));

    // Should show confirmation modal
    await waitFor(() => {
      expect(screen.getByText("Revoke Membership")).toBeInTheDocument();
    });
  });

  it("closes revoke modal when cancelled", async () => {
    const { getReadOnlyMembershipSbt } =
      await import("../lib/readOnlyContracts");
    (getReadOnlyMembershipSbt as ReturnType<typeof vi.fn>).mockReturnValue({
      get_member_count: vi.fn().mockResolvedValue({ result: BigInt(1) }),
      get_members: vi.fn().mockResolvedValue({
        result: ["GOTHER..."],
      }),
      has: vi.fn().mockResolvedValue({ result: true }),
      get_alias: vi.fn().mockResolvedValue({ result: null }),
    });

    render(<ManageMembers {...adminProps} />);

    await waitFor(() => {
      const actionButtons = document.querySelectorAll(
        '[title="Member actions"]',
      );
      expect(actionButtons.length).toBeGreaterThan(0);
    });

    // Click the actions menu button (three dots)
    const actionButton = document.querySelector('[title="Member actions"]');
    if (actionButton) {
      fireEvent.click(actionButton);
    }

    // Wait for dropdown menu to appear and click Remove Member
    await waitFor(() => {
      expect(screen.getByText("Remove Member")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Remove Member"));

    // Wait for modal to appear
    await waitFor(() => {
      expect(screen.getByText("Revoke Membership")).toBeInTheDocument();
    });

    // Click cancel (look for Cancel button in the modal)
    const cancelButton = screen.getByText("Cancel");
    fireEvent.click(cancelButton);

    // Modal should close
    await waitFor(() => {
      expect(screen.queryByText("Revoke Membership")).not.toBeInTheDocument();
    });
  });
});
