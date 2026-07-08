interface AlertProps {
  children: React.ReactNode;
  variant?: "error" | "success" | "warning" | "info";
  className?: string;
}

const variantStyles = {
  error:
    "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-100",
  success:
    "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-800 dark:text-green-100",
  warning:
    "bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-100",
  info: "bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-100",
};

export default function Alert({
  children,
  variant = "error",
  className = "",
}: AlertProps) {
  return (
    <div
      className={`border px-4 py-3 rounded-lg ${variantStyles[variant]} ${className}`}
    >
      {children}
    </div>
  );
}
