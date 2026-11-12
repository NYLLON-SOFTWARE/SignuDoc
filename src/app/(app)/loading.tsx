export default function AppLoading() {
  return (
    <div aria-label="Loading page" className="space-y-5">
      <section className="panel px-6 py-7 sm:px-8">
        <div className="space-y-3">
          <div className="h-9 w-56 animate-pulse rounded-full bg-[#eeeff4]" />
          <div className="h-4 w-full max-w-md animate-pulse rounded-full bg-[#eeeff4]" />
        </div>
      </section>
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            className="h-10 w-20 animate-pulse rounded-xl bg-(--surface-strong)"
            key={index}
          />
        ))}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            className="panel space-y-3.5 rounded-[1.25rem] p-3.5"
            key={index}
          >
            <div className="h-52 animate-pulse rounded-2xl bg-(--surface)" />
            <div className="h-4 w-3/4 animate-pulse rounded-full bg-[#eeeff4]" />
            <div className="h-3 w-1/2 animate-pulse rounded-full bg-[#eeeff4]" />
          </div>
        ))}
      </div>
    </div>
  );
}
