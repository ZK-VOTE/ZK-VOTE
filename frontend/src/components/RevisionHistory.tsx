import { useState, useEffect } from "react";
import { X, Clock, Loader2, Trash2 } from "lucide-react";
import { Button } from "./ui/Button";
import { useMounted } from "../hooks/useMounted";
import SafeMarkdown from "./SafeMarkdown";
import {
  type CommentWithContent,
  type CommentMetadata,
  fetchCommentContent,
  formatRelativeTime,
} from "../lib/comments";

interface RevisionHistoryProps {
  comment: CommentWithContent;
  onClose: () => void;
}

interface RevisionEntry {
  cid: string;
  content: CommentMetadata | null;
  isLoading: boolean;
  isCurrent: boolean;
  isDeleted?: boolean;
  deletedBy?: "user" | "admin" | null;
  deletedAt?: number;
}

export default function RevisionHistory({
  comment,
  onClose,
}: RevisionHistoryProps) {
  const [revisions, setRevisions] = useState<RevisionEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const mounted = useMounted();

  useEffect(() => {
    // Build list of revisions (oldest first, current/deleted last)
    const allCids = [...comment.revisionCids, comment.contentCid];
    const initialRevisions: RevisionEntry[] = allCids.map((cid, index) => ({
      cid,
      content: index === allCids.length - 1 ? comment.content : null,
      isLoading: index !== allCids.length - 1,
      isCurrent: index === allCids.length - 1 && !comment.deleted,
    }));

    // If the comment is deleted, add a "Deleted" entry at the end
    if (comment.deleted) {
      initialRevisions.push({
        cid: "",
        content: null,
        isLoading: false,
        isCurrent: true,
        isDeleted: true,
        deletedBy: comment.deletedBy,
        deletedAt: comment.updatedAt,
      });
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: one-time revision list initialization
    setRevisions(initialRevisions);
    setSelectedIndex(initialRevisions.length - 1);

    // Fetch content for historical revisions
    const fetchRevisions = async () => {
      const updatedRevisions = [...initialRevisions];

      for (let i = 0; i < comment.revisionCids.length; i++) {
        const cid = comment.revisionCids[i];
        try {
          const content = await fetchCommentContent(cid);
          updatedRevisions[i] = {
            ...updatedRevisions[i],
            content,
            isLoading: false,
          };
          setRevisions([...updatedRevisions]);
        } catch (err) {
          console.error(`Failed to fetch revision ${cid}:`, err);
          updatedRevisions[i] = {
            ...updatedRevisions[i],
            isLoading: false,
          };
          setRevisions([...updatedRevisions]);
        }
      }
    };

    if (comment.revisionCids.length > 0) {
      fetchRevisions();
    }
  }, [comment]);

  const selectedRevision = revisions[selectedIndex];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-background border border-border rounded-lg shadow-xl w-[calc(100%-2rem)] max-w-2xl max-h-[85dvh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <h3 className="text-lg font-semibold">Revision History</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-10 w-10 p-2 sm:h-8 sm:w-8"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden flex flex-col sm:flex-row">
          {/* Revision list */}
          <div className="w-full sm:w-48 border-b sm:border-b-0 sm:border-e border-border overflow-x-auto sm:overflow-y-auto shrink-0 flex sm:flex-col">
            {revisions.map((revision, index) => (
              <button
                key={revision.cid || `deleted-${index}`}
                onClick={() => setSelectedIndex(index)}
                className={`flex-1 sm:flex-none px-4 py-3 min-h-[48px] text-start border-e sm:border-e-0 border-b-0 sm:border-b border-border hover:bg-muted/50 transition-colors shrink-0 ${
                  selectedIndex === index ? "bg-muted font-medium" : ""
                }`}
              >
                <div className="flex items-center gap-2">
                  {revision.isDeleted ? (
                    <Trash2 className="w-3.5 h-3.5 text-destructive shrink-0" />
                  ) : (
                    <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  )}
                  <span
                    className={`text-sm ${revision.isDeleted ? "text-destructive" : ""}`}
                  >
                    {revision.isDeleted
                      ? "Deleted"
                      : revision.isCurrent
                        ? "Current"
                        : `v${index + 1}`}
                  </span>
                </div>
                {revision.isDeleted && revision.deletedAt ? (
                  <p className="text-xs text-muted-foreground mt-1">
                    {mounted
                      ? new Date(revision.deletedAt * 1000).toLocaleString()
                      : ""}
                  </p>
                ) : revision.content?.createdAt ? (
                  <p className="text-xs text-muted-foreground mt-1">
                    {mounted
                      ? new Date(revision.content.createdAt).toLocaleString()
                      : ""}
                  </p>
                ) : null}
              </button>
            ))}
          </div>

          {/* Selected revision content */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-6">
            {selectedRevision?.isLoading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : selectedRevision?.isDeleted ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <Trash2 className="w-4 h-4" />
                  <span>
                    Deleted by{" "}
                    {selectedRevision.deletedBy === "admin" ? "admin" : "user"}
                    {selectedRevision.deletedAt && (
                      <> {formatRelativeTime(selectedRevision.deletedAt)}</>
                    )}
                  </span>
                </div>
                <p className="text-muted-foreground italic">
                  This comment has been deleted. Select a previous version to
                  view the original content.
                </p>
              </div>
            ) : selectedRevision?.content ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="w-4 h-4" />
                  {selectedRevision.isCurrent ? (
                    <span>Current version</span>
                  ) : (
                    <span>
                      Edited{" "}
                      {formatRelativeTime(
                        Math.floor(
                          new Date(
                            selectedRevision.content.createdAt,
                          ).getTime() / 1000,
                        ),
                      )}
                    </span>
                  )}
                </div>
                <SafeMarkdown source={selectedRevision.content.body} />
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                Failed to load revision content
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border bg-muted/30">
          <p className="text-xs text-muted-foreground">
            {revisions.length} revision{revisions.length !== 1 ? "s" : ""} -{" "}
            Comment #{comment.id}
          </p>
        </div>
      </div>
    </div>
  );
}
