'use client';

import React from 'react';

/** Skeleton for a single customer search result card */
export const CustomerCardSkeleton = React.memo(function CustomerCardSkeleton() {
  return (
    <div className="px-4 py-3.5 border-l-4 border-surface-4 flex flex-col gap-2 animate-fade-in">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="skeleton h-5 w-40 mb-1.5" />
          <div className="skeleton h-3.5 w-28" />
        </div>
        <div className="skeleton h-6 w-20 rounded-full shrink-0" />
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        <div className="skeleton h-3.5 w-36" />
        <div className="skeleton h-3.5 w-28" />
        <div className="skeleton h-3.5 w-24" />
      </div>
    </div>
  );
});

/** Skeleton for search results list (multiple cards) */
export const SearchResultsSkeleton = React.memo(function SearchResultsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="card overflow-hidden animate-fade-in">
      <div className="px-5 py-3 border-b border-surface-4">
        <div className="skeleton h-3.5 w-48" />
      </div>
      <div className="divide-y divide-surface-3">
        {Array.from({ length: count }).map((_, i) => (
          <CustomerCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
});

/** Skeleton for the customer detail panel */
export const CustomerDetailSkeleton = React.memo(function CustomerDetailSkeleton() {
  return (
    <div className="card overflow-hidden animate-fade-in">
      {/* Header */}
      <div className="flex items-start gap-4 p-5 border-b border-surface-4">
        <div className="skeleton w-20 h-20 rounded-2xl shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="skeleton h-6 w-48 mb-2" />
          <div className="skeleton h-4 w-32 mb-3" />
          <div className="flex gap-2">
            <div className="skeleton h-7 w-20 rounded-full" />
            <div className="skeleton h-7 w-28 rounded-lg" />
          </div>
        </div>
      </div>
      {/* Progress bar */}
      <div className="px-5 py-3 border-b border-surface-4 bg-surface-2">
        <div className="flex justify-between mb-2">
          <div className="skeleton h-3 w-20" />
          <div className="skeleton h-3 w-16" />
        </div>
        <div className="skeleton h-2 w-full rounded-full" />
      </div>
      {/* Detail grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-surface-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-white px-4 py-3">
            <div className="skeleton h-3 w-16 mb-1.5" />
            <div className="skeleton h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
});

/** Skeleton for payment summary tile grid */
export const PaymentSummarySkeleton = React.memo(function PaymentSummarySkeleton() {
  return (
    <div className="card overflow-hidden border-l-4 border-surface-4 animate-fade-in">
      {/* Header */}
      <div className="bg-surface-3 px-5 py-3 flex items-center justify-between">
        <div>
          <div className="skeleton h-3 w-32 mb-1.5" />
          <div className="skeleton h-4 w-24" />
        </div>
        <div className="skeleton h-8 w-16" />
      </div>
      {/* Tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-surface-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white px-4 py-3">
            <div className="skeleton h-3 w-20 mb-2" />
            <div className="skeleton h-6 w-28 mb-1" />
            <div className="skeleton h-2.5 w-24" />
          </div>
        ))}
      </div>
      {/* Progress bar */}
      <div className="px-5 py-3 bg-white">
        <div className="flex justify-between mb-2">
          <div className="skeleton h-3 w-32" />
          <div className="skeleton h-3 w-10" />
        </div>
        <div className="skeleton h-2.5 w-full rounded-full" />
      </div>
    </div>
  );
});
