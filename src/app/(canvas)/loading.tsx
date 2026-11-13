export default function CanvasLoading() {
  return (
    <div className="grid min-h-[calc(100vh-73px)] lg:grid-cols-[272px_minmax(0,1fr)]">
      <aside className="hidden py-5 pl-5 lg:block">
        <div className="panel space-y-2 rounded-[1.25rem] p-4">
          <div className="h-4 w-20 animate-pulse rounded-full bg-[#eeeff4]" />
          {Array.from({ length: 5 }).map((_, index) => (
            <div
              className="h-12 animate-pulse rounded-[0.875rem] bg-(--surface)"
              key={index}
            />
          ))}
        </div>
      </aside>
      <section className="p-4 sm:p-5">
        <div className="panel rounded-[1.25rem] p-5 sm:p-6">
          <div className="mx-auto h-[560px] max-w-[720px] animate-pulse rounded-2xl bg-(--surface)" />
        </div>
      </section>
    </div>
  );
}
