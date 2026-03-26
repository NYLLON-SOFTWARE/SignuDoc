type StepIndicatorProps = {
  current: number;
  steps: string[];
};

export function StepIndicator({ current, steps }: StepIndicatorProps) {
  return (
    <section
      className="editorial-panel px-4 py-4 sm:px-5"
      data-animate="enter"
      data-animate-delay="1"
    >
      <ol className="grid gap-3 sm:grid-cols-4">
        {steps.map((step, index) => {
          const isComplete = index < current - 1;
          const isCurrent = index === current - 1;

          return (
            <li
              className={`flex items-center gap-3 border px-3 py-2 ${
                isCurrent ? "border-(--accent) bg-[#fff8f8]" : "border-(--border) bg-white"
              }`}
              key={step}
            >
              <span
                className={`inline-flex size-8 shrink-0 items-center justify-center border text-xs font-bold ${
                  isCurrent
                    ? "border-(--accent) bg-(--accent) text-white"
                    : isComplete
                      ? "border-black bg-black text-white"
                      : "border-(--border) bg-white text-(--tertiary)"
                }`}
              >
                {index + 1}
              </span>
              <span
                className={`[font-family:var(--font-mono)] text-[0.72rem] font-semibold uppercase tracking-[0.22em] ${
                  isCurrent || isComplete ? "text-(--fg)" : "text-(--tertiary)"
                }`}
              >
                {step}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
