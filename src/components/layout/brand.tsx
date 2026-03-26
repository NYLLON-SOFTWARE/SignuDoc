import Link from "next/link";

type BrandProps = {
  className?: string;
  compact?: boolean;
  href?: string;
  labelClassName?: string;
};

export function Brand({
  className = "",
  compact = false,
  href = "/",
  labelClassName = "",
}: BrandProps) {
  return (
    <Link
      aria-label="SignuDoc"
      className={`inline-flex items-center text-(--fg) ${className}`}
      href={href}
    >
      {!compact ? (
        <span
          className={`text-[1.28rem] font-extrabold tracking-[-0.035em] sm:text-[1.45rem] ${labelClassName}`}
        >
          Signu<span className="text-(--accent)">Doc</span>
        </span>
      ) : null}
    </Link>
  );
}
