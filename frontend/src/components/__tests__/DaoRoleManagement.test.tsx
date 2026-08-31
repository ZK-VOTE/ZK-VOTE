/**
 * DAO Role Management Component Tests
 *
 * Tests for DaoRoleManagement component:
 * - Role assignment UI
 * - Role revocation
 * - Role display and filtering
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DaoRoleManagement } from "../components/DaoRoleManagement";

describe("DaoRoleManagement Component", () => {
  const mockOnAssignRole = jest.fn();
  const mockOnRevokeRole = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should render the component", () => {
    render(
      <DaoRoleManagement
        daoId={1}
        onAssignRole={mockOnAssignRole}
        onRevokeRole={mockOnRevokeRole}
      />
    );

    expect(screen.getByText("DAO Role Management")).toBeInTheDocument();
  });

  it("should have member address input and role selector", () => {
    render(
      <DaoRoleManagement
        daoId={1}
        onAssignRole={mockOnAssignRole}
        onRevokeRole={mockOnRevokeRole}
      />
    );

    expect(screen.getByPlaceholderText("G...")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Member")).toBeInTheDocument();
    expect(screen.getByText("Assign Role")).toBeInTheDocument();
  });

  it("should have role options: Admin, Member, Auditor", () => {
    render(
      <DaoRoleManagement
        daoId={1}
        onAssignRole={mockOnAssignRole}
        onRevokeRole={mockOnRevokeRole}
      />
    );

    const roleSelect = screen.getByDisplayValue("Member") as HTMLSelectElement;
    expect(roleSelect.options.length).toBe(3);
    expect(roleSelect.options[0].text).toBe("Admin");
    expect(roleSelect.options[1].text).toBe("Member");
    expect(roleSelect.options[2].text).toBe("Auditor");
  });

  it("should call onAssignRole when form is submitted", async () => {
    mockOnAssignRole.mockResolvedValueOnce(undefined);

    render(
      <DaoRoleManagement
        daoId={1}
        onAssignRole={mockOnAssignRole}
        onRevokeRole={mockOnRevokeRole}
      />
    );

    const input = screen.getByPlaceholderText("G...") as HTMLInputElement;
    const submitButton = screen.getByText("Assign Role");

    await userEvent.type(
      input,
      "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S"
    );
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(mockOnAssignRole).toHaveBeenCalledWith(
        "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S",
        "Member"
      );
    });
  });

  it("should change role selection", async () => {
    mockOnAssignRole.mockResolvedValueOnce(undefined);

    render(
      <DaoRoleManagement
        daoId={1}
        onAssignRole={mockOnAssignRole}
        onRevokeRole={mockOnRevokeRole}
      />
    );

    const roleSelect = screen.getByDisplayValue("Member") as HTMLSelectElement;
    await userEvent.selectOptions(roleSelect, "Admin");

    expect(roleSelect.value).toBe("Admin");

    const input = screen.getByPlaceholderText("G...") as HTMLInputElement;
    const submitButton = screen.getByText("Assign Role");

    await userEvent.type(
      input,
      "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S"
    );
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(mockOnAssignRole).toHaveBeenCalledWith(
        "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S",
        "Admin"
      );
    });
  });

  it("should display assigned roles", async () => {
    mockOnAssignRole.mockResolvedValueOnce(undefined);

    const { rerender } = render(
      <DaoRoleManagement
        daoId={1}
        onAssignRole={mockOnAssignRole}
        onRevokeRole={mockOnRevokeRole}
      />
    );

    const input = screen.getByPlaceholderText("G...") as HTMLInputElement;
    const submitButton = screen.getByText("Assign Role");

    await userEvent.type(
      input,
      "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S"
    );
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(
        screen.getByText(/GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S/)
      ).toBeInTheDocument();
      expect(screen.getByText("Member")).toBeInTheDocument();
    });
  });

  it("should revoke member role", async () => {
    mockOnAssignRole.mockResolvedValueOnce(undefined);
    mockOnRevokeRole.mockResolvedValueOnce(undefined);

    window.confirm = jest.fn(() => true);

    render(
      <DaoRoleManagement
        daoId={1}
        onAssignRole={mockOnAssignRole}
        onRevokeRole={mockOnRevokeRole}
      />
    );

    const input = screen.getByPlaceholderText("G...") as HTMLInputElement;
    const submitButton = screen.getByText("Assign Role");

    await userEvent.type(
      input,
      "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S"
    );
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText("Revoke")).toBeInTheDocument();
    });

    const revokeButton = screen.getByText("Revoke");
    await userEvent.click(revokeButton);

    await waitFor(() => {
      expect(mockOnRevokeRole).toHaveBeenCalledWith(
        "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S"
      );
    });
  });

  it("should show error when onAssignRole fails", async () => {
    mockOnAssignRole.mockRejectedValueOnce(new Error("Assignment failed"));

    render(
      <DaoRoleManagement
        daoId={1}
        onAssignRole={mockOnAssignRole}
        onRevokeRole={mockOnRevokeRole}
        error="Assignment failed"
      />
    );

    expect(screen.getByText(/Assignment failed/)).toBeInTheDocument();
  });

  it("should disable form when loading", () => {
    render(
      <DaoRoleManagement
        daoId={1}
        onAssignRole={mockOnAssignRole}
        onRevokeRole={mockOnRevokeRole}
        loading={true}
      />
    );

    const input = screen.getByPlaceholderText("G...") as HTMLInputElement;
    const submitButton = screen.getByText("Assigning...") as HTMLButtonElement;

    expect(input.disabled).toBe(true);
    expect(submitButton.disabled).toBe(true);
  });

  it("should show role badge colors", async () => {
    mockOnAssignRole.mockResolvedValueOnce(undefined);

    render(
      <DaoRoleManagement
        daoId={1}
        onAssignRole={mockOnAssignRole}
        onRevokeRole={mockOnRevokeRole}
      />
    );

    const input = screen.getByPlaceholderText("G...") as HTMLInputElement;
    const roleSelect = screen.getByDisplayValue("Member") as HTMLSelectElement;
    const submitButton = screen.getByText("Assign Role");

    // Test Member role
    await userEvent.type(
      input,
      "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S"
    );
    await userEvent.click(submitButton);

    await waitFor(() => {
      const badge = screen.getByText("Member");
      expect(badge.className).toContain("bg-blue-100");
      expect(badge.className).toContain("text-blue-800");
    });
  });
});
