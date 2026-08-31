/**
 * DaoRoleManagement Component
 *
 * Provides UI for DAO role assignment and management:
 * - Assign roles (Admin, Member, Auditor) to members
 * - Revoke member roles
 * - View member roles
 */

import React, { useState } from "react";

export type DaoRole = "Admin" | "Member" | "Auditor";

interface RoleAssignmentProps {
  daoId: number;
  onAssignRole: (member: string, role: DaoRole) => Promise<void>;
  onRevokeRole: (member: string) => Promise<void>;
  loading?: boolean;
  error?: string | null;
}

interface MemberRole {
  member: string;
  role: DaoRole | null;
  assignedAt?: number;
}

export const DaoRoleManagement: React.FC<RoleAssignmentProps> = ({
  daoId,
  onAssignRole,
  onRevokeRole,
  loading = false,
  error = null,
}) => {
  const [memberAddress, setMemberAddress] = useState("");
  const [selectedRole, setSelectedRole] = useState<DaoRole>("Member");
  const [assignedMembers, setAssignedMembers] = useState<MemberRole[]>([]);

  const handleAssignRole = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!memberAddress.trim()) {
      alert("Please enter a member address");
      return;
    }

    try {
      await onAssignRole(memberAddress, selectedRole);
      setAssignedMembers((prev) => [
        ...prev.filter((m) => m.member !== memberAddress),
        {
          member: memberAddress,
          role: selectedRole,
          assignedAt: Math.floor(Date.now() / 1000),
        },
      ]);
      setMemberAddress("");
    } catch (err) {
      console.error("Failed to assign role:", err);
    }
  };

  const handleRevokeRole = async (member: string) => {
    if (!window.confirm(`Revoke role for ${member}?`)) {
      return;
    }

    try {
      await onRevokeRole(member);
      setAssignedMembers((prev) => prev.filter((m) => m.member !== member));
    } catch (err) {
      console.error("Failed to revoke role:", err);
    }
  };

  const getRoleBadgeColor = (role: DaoRole | null) => {
    switch (role) {
      case "Admin":
        return "bg-red-100 text-red-800";
      case "Member":
        return "bg-blue-100 text-blue-800";
      case "Auditor":
        return "bg-yellow-100 text-yellow-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <h2 className="text-2xl font-bold mb-6">DAO Role Management</h2>

      {error && (
        <div className="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded">
          {error}
        </div>
      )}

      {/* Role Assignment Form */}
      <form onSubmit={handleAssignRole} className="mb-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Member Address
            </label>
            <input
              type="text"
              value={memberAddress}
              onChange={(e) => setMemberAddress(e.target.value)}
              placeholder="G..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={loading}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Role
            </label>
            <select
              value={selectedRole}
              onChange={(e) => setSelectedRole(e.target.value as DaoRole)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={loading}
            >
              <option value="Admin">Admin</option>
              <option value="Member">Member</option>
              <option value="Auditor">Auditor</option>
            </select>
          </div>

          <div className="flex items-end">
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white py-2 rounded-md hover:bg-blue-700 disabled:bg-gray-400 transition"
            >
              {loading ? "Assigning..." : "Assign Role"}
            </button>
          </div>
        </div>
      </form>

      {/* Assigned Roles List */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Assigned Roles</h3>
        {assignedMembers.length === 0 ? (
          <p className="text-gray-500">No roles assigned yet</p>
        ) : (
          <div className="space-y-2">
            {assignedMembers.map((member) => (
              <div
                key={member.member}
                className="flex items-center justify-between p-3 bg-gray-50 rounded-md border border-gray-200"
              >
                <div className="flex-1">
                  <p className="font-mono text-sm text-gray-900">
                    {member.member}
                  </p>
                  {member.assignedAt && (
                    <p className="text-xs text-gray-500">
                      Assigned:{" "}
                      {new Date(member.assignedAt * 1000).toLocaleDateString()}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <span className={`px-3 py-1 rounded-full text-sm font-medium ${getRoleBadgeColor(member.role)}`}>
                    {member.role || "None"}
                  </span>

                  <button
                    onClick={() => handleRevokeRole(member.member)}
                    disabled={loading}
                    className="px-3 py-1 bg-red-100 text-red-700 rounded-md hover:bg-red-200 disabled:opacity-50 transition text-sm"
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default DaoRoleManagement;
