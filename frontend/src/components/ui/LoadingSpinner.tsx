interface LoadingSpinnerProps {
  size?: "sm" | "md" | "lg";
  color?: "purple" | "blue" | "white";
  className?: string;
}

const sizeStyles = {
  sm: "h-4 w-4",
  md: "h-8 w-8",
  lg: "h-12 w-12",
};

const colorStyles = {
  purple: "border-border",
  blue: "border-blue-600",
  white: "border-white",
};

export default function LoadingSpinner({
  size = "md",
  color = "purple",
  className = "",
}: LoadingSpinnerProps) {
  return (
    <div
      className={`animate-spin rounded-full border-b-2 ${sizeStyles[size]} ${colorStyles[color]} ${className}`}
    />
  );
}

export function LoadingPage({ message }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center p-8">
      <LoadingSpinner size="lg" />
      {message && <p className="mt-4 text-muted-foreground">{message}</p>}
    </div>
  );
}
