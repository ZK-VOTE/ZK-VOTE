import { useState, useCallback, useRef, useEffect } from "react";
import MDEditor from "@uiw/react-md-editor";
import VoteModeSelector from "./VoteModeSelector";
import DeadlineInput from "./DeadlineInput";
import LoadingSpinner from "./LoadingSpinner";
import { Button } from "./Button";
import { Input } from "./Input";
import { Label } from "./Label";
import { Upload } from "lucide-react";
import { useTheme } from "../../hooks/useTheme";
import { relayerFetch } from "../../lib/api";
import {
  getLocalizedProposalTemplates,
  getProposalTemplate,
  validateProposalTemplateDraft,
  type TemplateLocale,
} from "../../lib/proposalTemplates";

interface ProposalMetadata {
  version: number;
  body: string;
  template?: { id: string; version: number };
  videoUrl?: string;
  image?: {
    cid: string;
    filename: string;
    mimeType: string;
  };
}

interface CreateProposalFormProps {
  onSubmit: (data: {
    title: string;
    contentCid: string;
    voteMode: "fixed" | "trailing";
    deadlineSeconds: number;
  }) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
  submitLabel?: string;
  submittingLabel?: string;
}

export default function CreateProposalForm({
  onSubmit,
  onCancel,
  isSubmitting = false,
  submitLabel = "Create Proposal",
  submittingLabel = "Creating...",
}: CreateProposalFormProps) {
  const { theme } = useTheme();
  const locale: TemplateLocale =
    typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ar")
      ? "ar" : "en";
  const templates = getLocalizedProposalTemplates(locale);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [voteMode, setVoteMode] = useState<"fixed" | "trailing">("trailing");
  const [deadlineSeconds, setDeadlineSeconds] = useState<string>(
    String(7 * 24 * 60 * 60),
  );
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [appliedTemplateId, setAppliedTemplateId] = useState<string | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);

  // Issue #383: applying a template only prefills — it never overwrites
  // text the member has already started typing.
  const applyTemplate = useCallback(
    (templateId: string) => {
      const template = getProposalTemplate(templateId, locale);
      if (!template) return;

      setAppliedTemplateId(templateId);
      setVoteMode(template.voteMode);
      setDeadlineSeconds(String(template.deadlineSeconds));
      if (!title.trim()) setTitle(template.titlePlaceholder);
      if (!body.trim()) setBody(template.bodyScaffold);
    },
    [title, body, locale],
  );

  // Remove toolbar buttons from tab order
  useEffect(() => {
    if (editorContainerRef.current) {
      const toolbarButtons = editorContainerRef.current.querySelectorAll(
        ".w-md-editor-toolbar button",
      );
      toolbarButtons.forEach((button) => {
        button.setAttribute("tabindex", "-1");
      });
    }
  }, []);

  const handleImageSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Validate file type
      if (!file.type.startsWith("image/")) {
        setUploadError("Please select an image file");
        return;
      }

      // Validate file size (5MB max)
      if (file.size > 5 * 1024 * 1024) {
        setUploadError("Image must be less than 5MB");
        return;
      }

      setImageFile(file);
      setUploadError(null);

      // Create preview
      const reader = new FileReader();
      reader.onload = (e) => {
        setImagePreview(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    },
    [],
  );

  const removeImage = useCallback(() => {
    setImageFile(null);
    setImagePreview(null);
  }, []);

  const uploadImage = async (
    file: File,
  ): Promise<{ cid: string; filename: string; mimeType: string } | null> => {
    const formData = new FormData();
    formData.append("image", file);

    const response = await relayerFetch("/ipfs/image", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to upload image");
    }

    const result = await response.json();
    return {
      cid: result.cid,
      filename: file.name,
      mimeType: file.type,
    };
  };

  const uploadMetadata = async (
    metadata: ProposalMetadata,
  ): Promise<string> => {
    const response = await relayerFetch("/ipfs/metadata", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(metadata),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to upload metadata");
    }

    const result = await response.json();
    return result.cid;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errors = validateProposalTemplateDraft({
      title, body, videoUrl: videoUrl.trim(), voteMode,
      deadlineSeconds: Number(deadlineSeconds),
    });
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setUploadError(null);

    try {
      let imageMeta:
        | { cid: string; filename: string; mimeType: string }
        | undefined;

      // Upload image if present
      if (imageFile) {
        setUploadingImage(true);
        const result = await uploadImage(imageFile);
        if (result) {
          imageMeta = result;
        }
        setUploadingImage(false);
      }

      // Build metadata
      const metadata: ProposalMetadata = {
        version: 1,
        body: body.trim(),
      };
      const appliedTemplate = appliedTemplateId
        ? getProposalTemplate(appliedTemplateId, locale)
        : undefined;
      if (appliedTemplate) {
        metadata.template = { id: appliedTemplate.id, version: appliedTemplate.version };
      }

      if (videoUrl.trim()) {
        metadata.videoUrl = videoUrl.trim();
      }

      if (imageMeta) {
        metadata.image = imageMeta;
      }

      // Upload metadata to IPFS
      const contentCid = await uploadMetadata(metadata);

      // Submit to contract
      await onSubmit({
        title: title.trim(),
        contentCid,
        voteMode,
        deadlineSeconds: parseInt(deadlineSeconds, 10) || 0,
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
      setUploadingImage(false);
    }
  };

  const isProcessing = isSubmitting || uploadingImage;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Templates */}
      <div className="space-y-2">
        <Label>Start from a template (optional)</Label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" dir={locale === "ar" ? "rtl" : "ltr"}>
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              disabled={isProcessing}
              onClick={() => applyTemplate(template.id)}
              className={`text-left rounded-lg border p-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                appliedTemplateId === template.id
                  ? "border-primary bg-primary/5"
                  : "border-input hover:border-primary/50"
              }`}
            >
              <p dir="auto" className="text-sm font-medium">{template.name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {template.description}
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* Title */}
      <div className="space-y-2">
        <Label>
          Title <span className="text-destructive">*</span>
        </Label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value.slice(0, 100))}
          placeholder="Brief proposal title (max 100 chars)"
          disabled={isProcessing}
          maxLength={100}
        />
        <p className="text-xs text-muted-foreground">{title.length}/100</p>
        {fieldErrors.title && <p role="alert" className="text-xs text-destructive">{fieldErrors.title}</p>}
      </div>

      {/* Markdown Body */}
      <div
        className="space-y-2"
        data-color-mode={theme}
        ref={editorContainerRef}
      >
        <Label>Description</Label>
        {fieldErrors.body && <p role="alert" className="text-xs text-destructive">{fieldErrors.body}</p>}
        <MDEditor
          value={body}
          onChange={(val) => setBody(val || "")}
          preview="edit"
          height={200}
          hideToolbar={false}
          enableScroll={true}
        />
        <p className="text-xs text-muted-foreground">
          Supports Markdown formatting
        </p>
      </div>

      {/* Video URL */}
      <div className="space-y-2">
        <Label>Video URL (optional)</Label>
        <Input
          value={videoUrl}
          onChange={(e) => setVideoUrl(e.target.value)}
          placeholder="https://youtube.com/watch?v=... or https://vimeo.com/..."
          disabled={isProcessing}
        />
        <p className="text-xs text-muted-foreground">YouTube or Vimeo links</p>
        {fieldErrors.videoUrl && <p role="alert" className="text-xs text-destructive">{fieldErrors.videoUrl}</p>}
      </div>

      {/* Image Upload */}
      <div className="space-y-2">
        <Label className="block">Image (optional)</Label>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageSelect}
            className="hidden"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessing || !!imagePreview}
            className="gap-2"
          >
            <Upload className="w-4 h-4" />
            Choose File
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Max 5MB, JPEG/PNG/GIF</p>
      </div>

      {/* Image Preview */}
      {imagePreview && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm text-muted-foreground">[Image #1]</Label>
            <button
              type="button"
              onClick={removeImage}
              className="text-xs text-white hover:text-white/70"
              disabled={isProcessing}
            >
              Remove
            </button>
          </div>
          <div className="rounded-lg border border-border overflow-hidden bg-muted/20">
            <img
              src={imagePreview}
              alt="Preview"
              className="max-w-full max-h-64 mx-auto object-contain"
            />
          </div>
        </div>
      )}

      {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}

      <VoteModeSelector
        value={voteMode}
        onChange={setVoteMode}
        disabled={isProcessing}
      />

      <DeadlineInput
        value={deadlineSeconds}
        onChange={setDeadlineSeconds}
        disabled={isProcessing}
      />
      {fieldErrors.deadlineSeconds && <p role="alert" className="text-xs text-destructive">{fieldErrors.deadlineSeconds}</p>}

      <div className="flex gap-2 pt-2">
        <Button
          type="submit"
          variant="outline"
          disabled={isProcessing || !title.trim()}
          className="flex-1"
        >
          {isProcessing && <LoadingSpinner size="sm" className="mr-2" />}
          {uploadingImage
            ? "Uploading..."
            : isSubmitting
              ? submittingLabel
              : submitLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isProcessing}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
