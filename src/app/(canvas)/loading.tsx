export default function CanvasLoading() {
  return (
    <div className="grid min-h-[calc(100vh-73px)] lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="hidden border-r border-(--border) bg-white p-5 lg:block">
        <div className="space-y-4">
          <div className="h-4 w-20 animate-pulse rounded-full bg-(--surface)" />
          {Array.from({ length: 5 }).map((_, index) => (
            <div
              className="h-12 animate-pulse rounded-2xl bg-(--surface)"
              key={index}
            />
          ))}
        </div>
      </aside>
      <section className="p-4 sm:p-6 lg:p-8">
        <div className="rounded-[32px] border border-(--border) bg-white p-5 shadow-(--shadow-soft) sm:p-6">
          <div className="mx-auto h-[560px] max-w-[720px] animate-pulse rounded-[28px] bg-(--surface)" />
        </div>
      </section>
    </div>
  );
}
