import { LoadingSpinner } from "./ui";
import { Card, CardContent } from "./ui/Card";
import { CheckCircle, Key, FileSignature } from "lucide-react";

interface RegistrationFlowProps {
  registrationStatus: string | null;
  isRegistering: boolean;
}

function getStepInfo(status: string | null) {
  if (!status) return null;

  if (status.includes("Step 1/2") || status.includes("existing credentials")) {
    return { step: 1, total: 2, icon: Key, label: status };
  }
  if (status.includes("Step 2/2")) {
    return { step: 2, total: 2, icon: FileSignature, label: status };
  }
  if (status.includes("complete") || status.includes("recovered")) {
    return { step: 2, total: 2, icon: CheckCircle, label: status, done: true };
  }
  if (status.includes("recovering")) {
    return { step: 2, total: 2, icon: FileSignature, label: status };
  }

  return { step: 1, total: 2, icon: Key, label: status };
}

export default function RegistrationFlow({
  registrationStatus,
  isRegistering,
}: RegistrationFlowProps) {
  if (!isRegistering && !registrationStatus) return null;

  const stepInfo = getStepInfo(registrationStatus);

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center gap-4">
          {/* Progress indicator */}
          <div className="flex items-center gap-2">
            {stepInfo?.done ? (
              <CheckCircle className="w-5 h-5 text-green-500" />
            ) : (
              <LoadingSpinner size="sm" color="blue" />
            )}
          </div>

          {/* Status text */}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">
              {registrationStatus || "Preparing registration..."}
            </p>
            {stepInfo && !stepInfo.done && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Please follow the prompts in your wallet
              </p>
            )}
          </div>

          {/* Step counter */}
          {stepInfo && (
            <div className="flex items-center gap-1.5 shrink-0">
              {Array.from({ length: stepInfo.total }, (_, i) => (
                <div
                  key={i}
                  className={`h-1.5 w-6 rounded-full transition-colors ${
                    i < stepInfo.step
                      ? stepInfo.done
                        ? "bg-green-500"
                        : "bg-blue-500"
                      : "bg-muted"
                  }`}
                />
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
