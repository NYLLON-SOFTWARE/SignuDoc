export default function AppLoading() {
  return (
    <div aria-label="Loading page" className="space-y-6">
      <section className="rounded-[28px] border border-(--border) bg-white px-6 py-6 shadow-(--shadow-card) sm:px-8">
        <div className="space-y-4">
          <div className="h-3 w-24 animate-pulse rounded-full bg-(--surface)" />
          <div className="h-9 w-56 animate-pulse rounded-full bg-(--surface)" />
          <div className="h-4 w-full max-w-xl animate-pulse rounded-full bg-(--surface)" />
        </div>
      </section>
      <section className="rounded-[28px] border border-(--border) bg-white p-6 shadow-(--shadow-card) sm:p-8">
        <div className="space-y-4">
          <div className="h-12 w-full animate-pulse rounded-2xl bg-(--surface)" />
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                className="h-10 w-24 animate-pulse rounded-full bg-(--surface)"
                key={index}
              />
            ))}
          </div>
          <div className="mt-6 space-y-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                className="h-20 animate-pulse rounded-[22px] bg-(--surface)"
                key={index}
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
