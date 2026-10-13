/** Original Ritrovo mark: two seats around a round table, seen from above. */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="var(--brand)" />
      <circle cx="32" cy="32" r="11" fill="var(--on-brand)" />
      <rect x="10" y="26" width="7" height="12" rx="3.5" fill="var(--on-brand)" opacity="0.85" />
      <rect x="47" y="26" width="7" height="12" rx="3.5" fill="var(--on-brand)" opacity="0.85" />
      <rect x="26" y="10" width="12" height="7" rx="3.5" fill="var(--on-brand)" opacity="0.55" />
    </svg>
  );
}
