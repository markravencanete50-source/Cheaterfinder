import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "cheaterfinder.tz";
const AUTO_SENTINEL = "auto";

export interface TimezoneOption {
  value: string;
  label: string;
}

export const TIMEZONE_OPTIONS: TimezoneOption[] = [
  { value: AUTO_SENTINEL, label: "Auto (browser)" },
  { value: "UTC", label: "UTC" },
  { value: "America/New_York", label: "New York" },
  { value: "America/Los_Angeles", label: "Los Angeles" },
  { value: "America/Sao_Paulo", label: "São Paulo" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Paris", label: "Paris" },
  { value: "Asia/Dubai", label: "Dubai" },
  { value: "Asia/Karachi", label: "Karachi" },
  { value: "Asia/Kolkata", label: "Kolkata" },
  { value: "Asia/Singapore", label: "Singapore" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "Australia/Sydney", label: "Sydney" },
];

function getBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function readInitial(): string {
  if (typeof window === "undefined") return "UTC";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // localStorage unavailable — fall through
  }
  return "UTC";
}

export interface UseTimezoneResult {
  /** Raw stored value, may be 'auto' or an IANA name. */
  selected: string;
  /** Resolved IANA zone name passed to APIs and used for display. */
  resolved: string;
  setTimezone: (value: string) => void;
  options: TimezoneOption[];
}

/**
 * Persisted timezone selector. Values are either an IANA zone or the special
 * 'auto' sentinel, which resolves to the browser's current timezone.
 */
export function useTimezone(): UseTimezoneResult {
  const [selected, setSelected] = useState<string>(readInitial);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, selected);
    } catch {
      // ignore quota / disabled storage
    }
  }, [selected]);

  const setTimezone = useCallback((value: string) => {
    setSelected(value);
  }, []);

  const resolved = selected === AUTO_SENTINEL ? getBrowserTimezone() : selected;

  return {
    selected,
    resolved,
    setTimezone,
    options: TIMEZONE_OPTIONS,
  };
}
