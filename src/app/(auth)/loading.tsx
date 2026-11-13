export default function AuthLoading() {
  return (
    <section
      aria-label="Loading authentication page"
      className="panel w-full max-w-[440px] p-8 sm:p-10"
    >
      <div className="space-y-3">
        <div className="h-3 w-24 animate-pulse rounded-full bg-[#eeeff4]" />
        <div className="h-8 w-48 animate-pulse rounded-full bg-[#eeeff4]" />
      </div>
      <div className="mt-8 space-y-5">
        <div className="h-[4.5rem] animate-pulse rounded-2xl bg-(--surface)" />
        <div className="h-[4.5rem] animate-pulse rounded-2xl bg-(--surface)" />
        <div className="h-12 animate-pulse rounded-[0.875rem] bg-[#eeeff4]" />
      </div>
    </section>
  );
}
