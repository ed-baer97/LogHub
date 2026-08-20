import { useId } from "react";

export default function Logo({
  size = 28,
  className,
  alt,
}: {
  size?: number;
  className?: string;
  alt?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const bg = `lh-bg-${uid}`;
  const labelled = Boolean(alt);

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={labelled ? "img" : undefined}
      aria-label={labelled ? alt : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id={bg} x1="18" y1="0" x2="46" y2="64" gradientUnits="userSpaceOnUse">
          <stop stopColor="#3ad4c5" />
          <stop offset=".46" stopColor="#178f87" />
          <stop offset="1" stopColor="#0a4541" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#${bg})`} />
      <rect x="1.15" y="1.15" width="61.7" height="61.7" rx="14.9" fill="none" stroke="#fff" strokeOpacity=".16" />
      <path
        d="M16.4 47.9C19.8 37.4 24 38.6 32 32S44.2 26.6 47.6 16.1"
        stroke="#f4fffd"
        strokeWidth="3.4"
        strokeLinecap="round"
      />
      <circle cx="32" cy="32" r="8.15" fill={`url(#${bg})`} />
      <circle cx="32" cy="32" r="6.45" stroke="#f4fffd" strokeWidth="2.6" />
      <circle cx="32" cy="32" r="2.45" fill="#f4fffd" />
      <circle cx="16.4" cy="47.9" r="3.35" fill="#f4fffd" />
      <circle cx="47.6" cy="16.1" r="3.35" fill="#f4fffd" />
    </svg>
  );
}
