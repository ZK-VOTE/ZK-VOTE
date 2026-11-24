import { AlertTriangle, Info, X } from "lucide-react";
import { Button } from "./Button";

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "warning" | "info";
  isLoading?: boolean;
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "danger",
  isLoading = false,
}: ConfirmModalProps) {
  if (!isOpen) return null;

  const variantStyles = {
    danger: {
      icon: AlertTriangle,
      iconColor: "text-destructive",
      buttonVariant: "destructive" as const,
    },
    warning: {
      icon: AlertTriangle,
      iconColor: "text-orange-500",
      buttonVariant: "default" as const,
    },
    info: {
      icon: Info,
      iconColor: "text-blue-500",
      buttonVariant: "default" as const,
    },
  };

  const { icon: Icon, iconColor, buttonVariant } = variantStyles[variant];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-background border border-border rounded-lg shadow-xl w-[calc(100%-2rem)] max-w-md max-h-[90dvh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <Icon className={`w-5 h-5 ${iconColor}`} />
            <h3 className="text-lg font-semibold">{title}</h3>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={isLoading}
            aria-label="Close"
            className="h-10 w-10 p-2 sm:h-8 sm:w-8"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto flex-1">
          <p className="text-sm text-muted-foreground break-words-all">
            {message}
          </p>
        </div>

        {/* Footer */}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 p-4 border-t border-border bg-muted/30 shrink-0">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isLoading}
            className="w-full sm:w-auto"
          >
            {cancelText}
          </Button>
          <Button
            variant={buttonVariant}
            onClick={onConfirm}
            disabled={isLoading}
            className="w-full sm:w-auto"
          >
            {isLoading ? "Processing..." : confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Alert modal for showing error/success messages (replaces alert())
interface AlertModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  message: string;
  variant?: "error" | "success" | "info";
}

export function AlertModal({
  isOpen,
  onClose,
  title,
  message,
  variant = "error",
}: AlertModalProps) {
  if (!isOpen) return null;

  const variantStyles = {
    error: {
      icon: AlertTriangle,
      iconColor: "text-destructive",
    },
    success: {
      icon: Info,
      iconColor: "text-green-500",
    },
    info: {
      icon: Info,
      iconColor: "text-blue-500",
    },
  };

  const { icon: Icon, iconColor } = variantStyles[variant];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-background border border-border rounded-lg shadow-xl w-[calc(100%-2rem)] max-w-md max-h-[90dvh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <Icon className={`w-5 h-5 ${iconColor}`} />
            <h3 className="text-lg font-semibold">{title}</h3>
          </div>
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
        <div className="p-4 overflow-y-auto flex-1">
          <p className="text-sm text-muted-foreground break-words-all">
            {message}
          </p>
        </div>

        {/* Footer */}
        <div className="flex justify-end p-4 border-t border-border bg-muted/30 shrink-0">
          <Button onClick={onClose} className="w-full sm:w-auto">
            OK
          </Button>
        </div>
      </div>
    </div>
  );
}
