import { CheckIcon } from "lucide-react";

type StepIndicatorProps = {
  current: number;
  steps: string[];
};

export function StepIndicator({ current, steps }: StepIndicatorProps) {
  return (
    <nav
      aria-label="Progress"
      className="panel px-3 py-3 sm:px-4"
      data-animate="enter"
      data-animate-delay="1"
    >
      <ol className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {steps.map((step, index) => {
          const isComplete = index < current - 1;
          const isCurrent = index === current - 1;

          return (
            <li
              aria-current={isCurrent ? "step" : undefined}
              className={`flex items-center gap-3 rounded-2xl px-3 py-2.5 ${
                isCurrent ? "bg-(--accent-softer)" : ""
              }`}
              key={step}
            >
              <span
                className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  isCurrent
                    ? "bg-(--accent) text-white"
                    : isComplete
                      ? "bg-(--accent-soft) text-(--accent-ink)"
                      : "bg-(--surface-strong) text-(--secondary)"
                }`}
              >
                {isComplete ? (
                  <CheckIcon aria-hidden="true" className="size-3.5" />
                ) : (
                  index + 1
                )}
              </span>
              <span
                className={`text-sm ${
                  isCurrent
                    ? "font-bold text-(--accent-ink)"
                    : isComplete
                      ? "font-semibold text-(--fg)"
                      : "font-semibold text-(--tertiary)"
                }`}
              >
                {step}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
