'use client';

import { useId } from 'react';

/**
 * TELEPOINT brand mark — a stylized "T" inside a navy rounded tile with an
 * electric-blue orbit swoosh and satellite dot. Rendered as inline SVG so it
 * stays crisp at every size and inherits no external assets.
 *
 * Used in the NavBar and login screen. The matching static version lives in
 * /public/logo.svg + /public/icon-192.svg for the favicon / PWA manifest.
 */
export default function Logo({ size = 32, className = '' }: { size?: number; className?: string }) {
  // useId keeps the gradient ids unique when several logos mount on one page.
  const uid = useId().replace(/[:]/g, '');
  const bg = `tp-bg-${uid}`;
  const blue = `tp-blue-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      role="img"
      aria-label="Telepoint"
      className={className}
    >
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1b3e7d" />
          <stop offset="1" stopColor="#0a1f44" />
        </linearGradient>
        <linearGradient id={blue} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5cc6ff" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
      </defs>

      {/* Navy tile */}
      <rect width="64" height="64" rx="16" fill={`url(#${bg})`} />

      {/* Orbit swoosh */}
      <g transform="rotate(-28 32 33)">
        <ellipse cx="32" cy="33" rx="27" ry="11.5" fill="none" stroke={`url(#${blue})`} strokeWidth="2.6" opacity="0.95" />
      </g>
      {/* Satellite dot riding the orbit */}
      <circle cx="50.5" cy="16.5" r="2.8" fill="#8ad4ff" />

      {/* The "T" */}
      <rect x="15" y="15.5" width="34" height="9.5" rx="3" fill="#ffffff" />
      <rect x="27" y="22" width="10" height="28" rx="3.2" fill="#ffffff" />
      {/* Blue facet on the stem for the 3D feel */}
      <rect x="32" y="24" width="5" height="24" rx="2.2" fill={`url(#${blue})`} />
    </svg>
  );
}
