import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DAOHeader, { type DAOHeaderProps, type DAOInfo } from "./DAOHeader";

// Mock react-markdown and remark-gfm since they are ESM-only modules
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => (
    <div data-testid="markdown">{children}</div>
  ),
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

// Mock the daoMetadata utilities
vi.mock("../lib/daoMetadata", () => ({
  getImageUrl: (cid: string) => `https://ipfs.example.com/${cid}`,
  getTwitterUrl: (handle: string) => `https://x.com/${handle}`,
}));

describe("DAOHeader", () => {
  const defaultDAO: DAOInfo = {
    id: 1,
    name: "Test DAO",
    creator: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
    hasMembership: false,
    isAdmin: false,
    treeInitialized: true,
    vkSet: true,
    membershipOpen: true,
    membersCanPropose: false,
    metadataCid: null,
  };

  const defaultProps: DAOHeaderProps = {
    dao: defaultDAO,
    metadata: null,
    activeTab: "proposals",
    publicKey: "GPUBLICKEY1234567890",
    hasKit: true,
    joining: false,
    onJoin: vi.fn(),
    isRegistered: false,
    hasUnregisteredCredentials: false,
    isRegistering: false,
    registrationStatus: null,
    onRegister: vi.fn(),
    navigateToTab: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("DAO name and ID", () => {
    it("renders the DAO name", () => {
      render(<DAOHeader {...defaultProps} />);

      expect(screen.getByText("Test DAO")).toBeInTheDocument();
    });

    it("renders the DAO ID", () => {
      render(<DAOHeader {...defaultProps} />);

      expect(screen.getByText("ID: 1")).toBeInTheDocument();
    });

    it("renders the truncated creator address", () => {
      render(<DAOHeader {...defaultProps} />);

      expect(screen.getByText(/Created by GABC\.\.\.4567/)).toBeInTheDocument();
    });
  });

  describe("Role badges", () => {
    it("shows Admin badge when user is admin", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, isAdmin: true },
      };
      render(<DAOHeader {...props} />);

      expect(screen.getByText("Admin")).toBeInTheDocument();
    });

    it("shows Member badge when user is member but not admin", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, hasMembership: true, isAdmin: false },
      };
      render(<DAOHeader {...props} />);

      expect(screen.getByText("Member")).toBeInTheDocument();
    });

    it("shows Non-member badge when user is neither admin nor member", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, hasMembership: false, isAdmin: false },
      };
      render(<DAOHeader {...props} />);

      expect(screen.getByText("Non-member")).toBeInTheDocument();
    });

    it("shows Admin badge instead of Member when user is both", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, hasMembership: true, isAdmin: true },
      };
      render(<DAOHeader {...props} />);

      expect(screen.getByText("Admin")).toBeInTheDocument();
      expect(screen.queryByText("Member")).not.toBeInTheDocument();
    });
  });

  describe("Membership status badges", () => {
    it("shows Open badge when membership is open", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, membershipOpen: true },
      };
      render(<DAOHeader {...props} />);

      expect(screen.getByText("Open")).toBeInTheDocument();
    });

    it("shows Closed badge when membership is closed", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, membershipOpen: false },
      };
      render(<DAOHeader {...props} />);

      expect(screen.getByText("Closed")).toBeInTheDocument();
    });
  });

  describe("Navigation buttons", () => {
    it("renders Overview button", () => {
      render(<DAOHeader {...defaultProps} />);

      // Overview appears in multiple locations (mobile dropdown label, desktop nav)
      const overviewButtons = screen.getAllByText("Overview");
      expect(overviewButtons.length).toBeGreaterThan(0);
    });

    it("renders Info button", () => {
      render(<DAOHeader {...defaultProps} />);

      const infoButtons = screen.getAllByText("Info");
      expect(infoButtons.length).toBeGreaterThan(0);
    });

    it("renders Members button", () => {
      render(<DAOHeader {...defaultProps} />);

      // "Members" appears as nav button text
      const membersButtons = screen.getAllByText("Members");
      expect(membersButtons.length).toBeGreaterThan(0);
    });

    it("calls navigateToTab with correct tab on click", () => {
      render(<DAOHeader {...defaultProps} />);

      // Get the desktop Info buttons (there are multiple due to responsive layout)
      const infoButtons = screen.getAllByText("Info");
      fireEvent.click(infoButtons[0]);

      expect(defaultProps.navigateToTab).toHaveBeenCalledWith("info");
    });

    it("shows Settings button for admin users", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, isAdmin: true },
      };
      render(<DAOHeader {...props} />);

      const settingsButtons = screen.getAllByText("Settings");
      expect(settingsButtons.length).toBeGreaterThan(0);
    });

    it("does not show Settings button for non-admin users", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, isAdmin: false },
      };
      render(<DAOHeader {...props} />);

      expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    });

    it("shows Add Proposal button for admin users when vkSet", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, isAdmin: true, vkSet: true },
      };
      render(<DAOHeader {...props} />);

      const proposalButtons = screen.getAllByText("Add Proposal");
      expect(proposalButtons.length).toBeGreaterThan(0);
    });

    it("shows Add Proposal button for members who can propose", () => {
      const props = {
        ...defaultProps,
        dao: {
          ...defaultDAO,
          hasMembership: true,
          membersCanPropose: true,
          vkSet: true,
        },
      };
      render(<DAOHeader {...props} />);

      const proposalButtons = screen.getAllByText("Add Proposal");
      expect(proposalButtons.length).toBeGreaterThan(0);
    });

    it("does not show Add Proposal button when vkSet is false", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, isAdmin: true, vkSet: false },
      };
      render(<DAOHeader {...props} />);

      expect(screen.queryByText("Add Proposal")).not.toBeInTheDocument();
    });
  });

  describe("Join button", () => {
    it("shows Join DAO button for non-members when membership is open", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, hasMembership: false, membershipOpen: true },
        publicKey: "GPUBLICKEY",
      };
      render(<DAOHeader {...props} />);

      const joinButtons = screen.getAllByText("Join DAO");
      expect(joinButtons.length).toBeGreaterThan(0);
    });

    it("does not show Join DAO button when user is already a member", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, hasMembership: true, membershipOpen: true },
      };
      render(<DAOHeader {...props} />);

      expect(screen.queryByText("Join DAO")).not.toBeInTheDocument();
    });

    it("does not show Join DAO button when membership is closed", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, hasMembership: false, membershipOpen: false },
      };
      render(<DAOHeader {...props} />);

      expect(screen.queryByText("Join DAO")).not.toBeInTheDocument();
    });

    it("does not show Join DAO button when no wallet connected", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, hasMembership: false, membershipOpen: true },
        publicKey: null,
      };
      render(<DAOHeader {...props} />);

      expect(screen.queryByText("Join DAO")).not.toBeInTheDocument();
    });

    it("shows Joining... text while join is in progress", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, hasMembership: false, membershipOpen: true },
        publicKey: "GPUBLICKEY",
        joining: true,
      };
      render(<DAOHeader {...props} />);

      const joiningTexts = screen.getAllByText("Joining...");
      expect(joiningTexts.length).toBeGreaterThan(0);
    });

    it("calls onJoin when Join DAO button is clicked", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, hasMembership: false, membershipOpen: true },
        publicKey: "GPUBLICKEY",
      };
      render(<DAOHeader {...props} />);

      const joinButtons = screen.getAllByText("Join DAO");
      fireEvent.click(joinButtons[0]);

      expect(defaultProps.onJoin).toHaveBeenCalled();
    });
  });

  describe("Registration button", () => {
    it("shows Register to Vote for members who are not registered", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, hasMembership: true },
        isRegistered: false,
        hasUnregisteredCredentials: false,
        publicKey: "GPUBLICKEY",
      };
      render(<DAOHeader {...props} />);

      const registerButtons = screen.getAllByText("Register to Vote");
      expect(registerButtons.length).toBeGreaterThan(0);
    });

    it("shows Complete Registration for members with unregistered credentials", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, hasMembership: true },
        isRegistered: false,
        hasUnregisteredCredentials: true,
        publicKey: "GPUBLICKEY",
      };
      render(<DAOHeader {...props} />);

      const completeButtons = screen.getAllByText("Complete Registration");
      expect(completeButtons.length).toBeGreaterThan(0);
    });

    it("does not show registration button when already registered", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, hasMembership: true },
        isRegistered: true,
        publicKey: "GPUBLICKEY",
      };
      render(<DAOHeader {...props} />);

      expect(screen.queryByText("Register to Vote")).not.toBeInTheDocument();
      expect(
        screen.queryByText("Complete Registration"),
      ).not.toBeInTheDocument();
    });

    it("does not show registration button for non-members", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, hasMembership: false },
        isRegistered: false,
        publicKey: "GPUBLICKEY",
      };
      render(<DAOHeader {...props} />);

      expect(screen.queryByText("Register to Vote")).not.toBeInTheDocument();
    });

    it("shows registration status while registering", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, hasMembership: true },
        isRegistered: false,
        isRegistering: true,
        registrationStatus: "Generating commitment...",
        publicKey: "GPUBLICKEY",
      };
      render(<DAOHeader {...props} />);

      const statusTexts = screen.getAllByText("Generating commitment...");
      expect(statusTexts.length).toBeGreaterThan(0);
    });

    it("calls onRegister when registration button is clicked", () => {
      const props = {
        ...defaultProps,
        dao: { ...defaultDAO, hasMembership: true },
        isRegistered: false,
        publicKey: "GPUBLICKEY",
      };
      render(<DAOHeader {...props} />);

      const registerButtons = screen.getAllByText("Register to Vote");
      fireEvent.click(registerButtons[0]);

      expect(defaultProps.onRegister).toHaveBeenCalled();
    });
  });

  describe("Description", () => {
    it("shows description toggle when metadata has description", () => {
      const props = {
        ...defaultProps,
        metadata: {
          version: 1 as const,
          description: "This is a test DAO",
          updatedAt: new Date().toISOString(),
        },
      };
      render(<DAOHeader {...props} />);

      expect(screen.getByText("Show description")).toBeInTheDocument();
    });

    it("does not show description toggle when no metadata", () => {
      render(<DAOHeader {...defaultProps} />);

      expect(screen.queryByText("Show description")).not.toBeInTheDocument();
    });

    it("toggles description visibility on click", () => {
      const props = {
        ...defaultProps,
        metadata: {
          version: 1 as const,
          description: "This is a test DAO description",
          updatedAt: new Date().toISOString(),
        },
      };
      render(<DAOHeader {...props} />);

      // Initially hidden
      expect(
        screen.queryByText("This is a test DAO description"),
      ).not.toBeInTheDocument();

      // Click to show
      fireEvent.click(screen.getByText("Show description"));
      expect(
        screen.getByText("This is a test DAO description"),
      ).toBeInTheDocument();
      expect(screen.getByText("Hide description")).toBeInTheDocument();

      // Click to hide
      fireEvent.click(screen.getByText("Hide description"));
      expect(
        screen.queryByText("This is a test DAO description"),
      ).not.toBeInTheDocument();
    });
  });

  describe("Cover and profile images", () => {
    it("renders cover image when coverImageCid is provided", () => {
      const props = {
        ...defaultProps,
        metadata: {
          version: 1 as const,
          description: "",
          coverImageCid: "QmCoverCid123",
          updatedAt: new Date().toISOString(),
        },
      };
      render(<DAOHeader {...props} />);

      const coverImg = screen.getByAltText("DAO Cover");
      expect(coverImg).toBeInTheDocument();
      expect(coverImg.getAttribute("src")).toBe(
        "https://ipfs.example.com/QmCoverCid123",
      );
    });

    it("renders profile image when profileImageCid is provided", () => {
      const props = {
        ...defaultProps,
        metadata: {
          version: 1 as const,
          description: "",
          profileImageCid: "QmProfileCid456",
          updatedAt: new Date().toISOString(),
        },
      };
      render(<DAOHeader {...props} />);

      const profileImg = screen.getByAltText("DAO Profile");
      expect(profileImg).toBeInTheDocument();
      expect(profileImg.getAttribute("src")).toBe(
        "https://ipfs.example.com/QmProfileCid456",
      );
    });
  });

  describe("Social links", () => {
    it("renders social links when provided in metadata", () => {
      const props = {
        ...defaultProps,
        metadata: {
          version: 1 as const,
          description: "",
          links: {
            website: "https://example.com",
            twitter: "testdao",
            github: "https://github.com/testdao",
          },
          updatedAt: new Date().toISOString(),
        },
      };
      render(<DAOHeader {...props} />);

      // Links should be rendered as anchor elements with titles
      expect(screen.getByTitle("Website")).toBeInTheDocument();
      expect(screen.getByTitle("X (Twitter)")).toBeInTheDocument();
      expect(screen.getByTitle("GitHub")).toBeInTheDocument();
    });

    it("does not render social links when none provided", () => {
      render(<DAOHeader {...defaultProps} />);

      expect(screen.queryByTitle("Website")).not.toBeInTheDocument();
      expect(screen.queryByTitle("X (Twitter)")).not.toBeInTheDocument();
    });
  });
});
