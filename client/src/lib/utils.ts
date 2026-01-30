import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Format listing age for display
 * - <90 days: show days (e.g., "45d")
 * - 90-365 days: show months (e.g., "6m")
 * - 365-1825 days: show years (e.g., "2y")
 * - >1825 days (5+ years): show "5+"
 */
export function formatAge(ageDays: number): string {
  if (ageDays < 90) {
    return `${ageDays}d`;
  } else if (ageDays < 365) {
    const months = Math.floor(ageDays / 30);
    return `${months}m`;
  } else if (ageDays <= 1825) {
    const years = Math.floor(ageDays / 365);
    return `${years}y`;
  } else {
    return "5+";
  }
}
