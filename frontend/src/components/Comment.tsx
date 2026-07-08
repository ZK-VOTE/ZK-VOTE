import { useState, useMemo } from "react";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "./ui/Button";
import { Badge } from "./ui/Badge";
import { ConfirmModal, AlertModal } from "./ui/ConfirmModal";
import {
  MessageSquare,
  ChevronDown,
  ChevronRight,
  Edit2,
  Trash2,
  History,
  User,
  EyeOff,
  MoreHorizontal,
  Loader2,
} from "lucide-react";
import CommentForm from "./CommentForm";
import {
  type CommentWithContent,
  formatRelativeTime,
  truncateAddress,
  deleteComment,
  uploadCommentContent,
  editComment,
} from "../lib/comments";
import { initializeContractClients } from "../lib/contracts";

interface CommentProps {
  comment: CommentWithContent;
  daoId: number;
  proposalId: number;
  publicKey: string;
  kit: StellarWalletsKit | null;
  hasMembership: boolean;
  isRegistered: boolean;
  eligibleRoot: bigint;
  isAdmin: boolean;
  nullifierMap: Map<string, number>;
  depth?: number;
  onRefresh: () => void;
  onShowRevisions?: (comment: CommentWithContent) => void;
}

export default function Comment({
  comment,
  daoId,
  proposalId,
  publicKey,
  kit,
  hasMembership,
  isRegistered,
  eligibleRoot,
  isAdmin,
  nullifierMap,
  depth = 0,
  onRefresh,
  onShowRevisions,
}: CommentProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.content?.body || "");
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Modal states
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [alertModal, setAlertModal] = useState<{
    title: string;
    message: string;
  } | null>(null);

  // Initialize contract clients when needed (memoized for performance)
  const contractClients = useMemo(() => {
    if (!publicKey) return null;
    return initializeContractClients(publicKey);
  }, [publicKey]);

  const isOwnPublicComment = comment.author === publicKey;
  // Only public comments can be edited (anonymous edit requires ZK proof - not yet implemented)
  const canEdit = isOwnPublicComment && !comment.deleted;
  // Both public and anonymous comments can be deleted (anonymous delete also needs ZK proof - TODO)
  const canDelete = (isOwnPublicComment || isAdmin) && !comment.deleted;
  const canReply = depth === 0 && hasMembership && !comment.deleted;
  const hasRevisions = comment.revisionCids.length > 0;
  // Deleted comments should always show history if we have the original content CID
  const canViewHistory =
    hasRevisions || (comment.deleted && comment.contentCid);

  const handleDeleteClick = () => {
    setShowDeleteConfirm(true);
  };

  const handleDeleteConfirm = async () => {
    if (!kit || !contractClients) {
      setShowDeleteConfirm(false);
      setAlertModal({
        title: "Wallet Required",
        message: "Please connect your wallet to delete comments.",
      });
      return;
    }

    setIsDeleting(true);
    try {
      const result = await deleteComment({
        daoId,
        proposalId,
        commentId: comment.id,
        author: publicKey,
        commentsClient: contractClients.comments,
        kit,
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      setShowDeleteConfirm(false);
      onRefresh();
    } catch (err) {
      console.error("Failed to delete comment:", err);
      setShowDeleteConfirm(false);
      setAlertModal({
        title: "Delete Failed",
        message: "Failed to delete comment. Please try again.",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editBody.trim()) return;
    if (!kit || !contractClients) {
      setAlertModal({
        title: "Wallet Required",
        message: "Please connect your wallet to edit comments.",
      });
      return;
    }

    setIsSavingEdit(true);
    try {
      // Upload new content to IPFS
      const { cid } = await uploadCommentContent(editBody.trim());

      const result = await editComment({
        daoId,
        proposalId,
        commentId: comment.id,
        newContentCid: cid,
        author: publicKey,
        commentsClient: contractClients.comments,
        kit,
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      setIsEditing(false);
      onRefresh();
    } catch (err) {
      console.error("Failed to edit comment:", err);
      setAlertModal({
        title: "Edit Failed",
        message: "Failed to edit comment. Please try again.",
      });
    } finally {
      setIsSavingEdit(false);
    }
  };

  const renderDeletedContent = () => {
    const deletedBy = comment.deletedBy === "admin" ? "admin" : "user";
    return (
      <p className="text-muted-foreground italic text-sm">
        Comment deleted by {deletedBy}
        {canViewHistory && onShowRevisions && (
          <button
            onClick={() => onShowRevisions(comment)}
            className="ml-2 text-primary hover:underline"
          >
            (view history)
          </button>
        )}
      </p>
    );
  };

  return (
    <div className={`${depth > 0 ? "ml-6 border-l-2 border-muted pl-4" : ""}`}>
      <div className="group py-3">
        {/* Header */}
        <div className="flex items-center gap-2 mb-2">
          {/* Collapse toggle for comments with replies */}
          {comment.replies.length > 0 && (
            <button
              onClick={() => setIsCollapsed(!isCollapsed)}
              className="p-0.5 hover:bg-muted rounded"
            >
              {isCollapsed ? (
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              )}
            </button>
          )}

          {/* Author */}
          <div className="flex items-center gap-1.5">
            {comment.author ? (
              <>
                <User className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-sm font-medium">
                  {truncateAddress(comment.author)}
                </span>
              </>
            ) : (
              <>
                <EyeOff className="w-3.5 h-3.5 text-purple-500" />
                <span className="text-sm font-medium text-purple-600 dark:text-purple-400">
                  {comment.nullifier && nullifierMap.has(comment.nullifier)
                    ? `Anon Member ${nullifierMap.get(comment.nullifier)}`
                    : "Anonymous"}
                </span>
              </>
            )}
          </div>

          {/* Timestamp */}
          <span className="text-xs text-muted-foreground">
            {formatRelativeTime(comment.createdAt)}
          </span>

          {/* Edited badge */}
          {comment.updatedAt > comment.createdAt && !comment.deleted && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
              edited
            </Badge>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Actions */}
          {!comment.deleted && (
            <div className="relative">
              <button
                onClick={() => setShowActions(!showActions)}
                className="p-1 opacity-0 group-hover:opacity-100 hover:bg-muted rounded transition-opacity"
              >
                <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
              </button>

              {showActions && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowActions(false)}
                  />
                  <div className="absolute right-0 top-full mt-1 z-20 bg-popover border border-border rounded-md shadow-lg py-1 min-w-[120px]">
                    {canReply && (
                      <button
                        onClick={() => {
                          setShowReplyForm(true);
                          setShowActions(false);
                        }}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted flex items-center gap-2"
                      >
                        <MessageSquare className="w-3.5 h-3.5" />
                        Reply
                      </button>
                    )}
                    {canEdit && (
                      <button
                        onClick={() => {
                          setIsEditing(true);
                          setShowActions(false);
                        }}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted flex items-center gap-2"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                        Edit
                      </button>
                    )}
                    {hasRevisions && onShowRevisions && (
                      <button
                        onClick={() => {
                          onShowRevisions(comment);
                          setShowActions(false);
                        }}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted flex items-center gap-2"
                      >
                        <History className="w-3.5 h-3.5" />
                        History
                      </button>
                    )}
                    {canDelete && (
                      <button
                        onClick={() => {
                          handleDeleteClick();
                          setShowActions(false);
                        }}
                        disabled={isDeleting}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted flex items-center gap-2 text-destructive"
                      >
                        {isDeleting ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                        Delete
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Content */}
        {comment.deleted ? (
          renderDeletedContent()
        ) : isEditing ? (
          <div className="space-y-2">
            <textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background resize-none"
              rows={3}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleSaveEdit}
                disabled={isSavingEdit || !editBody.trim()}
              >
                {isSavingEdit ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                ) : null}
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setIsEditing(false);
                  setEditBody(comment.content?.body || "");
                }}
                disabled={isSavingEdit}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {comment.content?.body || "*Failed to load comment content*"}
            </ReactMarkdown>
          </div>
        )}

        {/* Quick reply button for top-level comments */}
        {canReply && !showReplyForm && !isEditing && (
          <button
            onClick={() => setShowReplyForm(true)}
            className="mt-2 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <MessageSquare className="w-3 h-3" />
            Reply
          </button>
        )}

        {/* Reply form */}
        {showReplyForm && (
          <div className="mt-3 pl-4 border-l-2 border-muted">
            <CommentForm
              daoId={daoId}
              proposalId={proposalId}
              publicKey={publicKey}
              kit={kit}
              hasMembership={hasMembership}
              isRegistered={isRegistered}
              eligibleRoot={eligibleRoot}
              parentId={comment.id}
              onSubmit={() => {
                setShowReplyForm(false);
                // Small delay to allow backend to index the new comment
                setTimeout(() => onRefresh(), 500);
              }}
              onCancel={() => setShowReplyForm(false)}
              placeholder="Write a reply..."
            />
          </div>
        )}
      </div>

      {/* Replies */}
      {!isCollapsed && comment.replies.length > 0 && (
        <div className="space-y-0">
          {comment.replies.map((reply) => (
            <Comment
              key={reply.id}
              comment={reply}
              daoId={daoId}
              proposalId={proposalId}
              publicKey={publicKey}
              kit={kit}
              hasMembership={hasMembership}
              isRegistered={isRegistered}
              eligibleRoot={eligibleRoot}
              isAdmin={isAdmin}
              nullifierMap={nullifierMap}
              depth={depth + 1}
              onRefresh={onRefresh}
              onShowRevisions={onShowRevisions}
            />
          ))}
        </div>
      )}

      {/* Collapsed indicator */}
      {isCollapsed && comment.replies.length > 0 && (
        <button
          onClick={() => setIsCollapsed(false)}
          className="ml-6 text-xs text-muted-foreground hover:text-foreground"
        >
          Show {comment.replies.length}{" "}
          {comment.replies.length === 1 ? "reply" : "replies"}
        </button>
      )}

      {/* Delete confirmation modal */}
      <ConfirmModal
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDeleteConfirm}
        title="Delete Comment"
        message="Are you sure you want to delete this comment? This action cannot be undone."
        confirmText="Delete"
        variant="danger"
        isLoading={isDeleting}
      />

      {/* Alert modal for errors */}
      {alertModal && (
        <AlertModal
          isOpen={!!alertModal}
          onClose={() => setAlertModal(null)}
          title={alertModal.title}
          message={alertModal.message}
          variant="error"
        />
      )}
    </div>
  );
}
