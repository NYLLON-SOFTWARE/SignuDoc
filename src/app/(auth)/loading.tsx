export default function AuthLoading() {
  return (
    <section
      aria-label="Loading authentication page"
      className="w-full max-w-[440px] rounded-[32px] border border-(--border) bg-white p-8 shadow-(--shadow-soft)"
    >
      <div className="space-y-4">
        <div className="h-3 w-24 animate-pulse rounded-full bg-(--surface)" />
        <div className="h-8 w-48 animate-pulse rounded-full bg-(--surface)" />
        <div className="h-4 w-full animate-pulse rounded-full bg-(--surface)" />
      </div>
      <div className="mt-8 space-y-5">
        <div className="h-20 animate-pulse rounded-[24px] bg-(--surface)" />
        <div className="h-20 animate-pulse rounded-[24px] bg-(--surface)" />
        <div className="h-12 animate-pulse rounded-full bg-(--surface)" />
      </div>
    </section>
  );
}
