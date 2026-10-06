/** Format provider minor units using the currency's display precision. */
export function formatBillingAmount(amount: number, currency: string, locale?: string): string {
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amount / 10 ** digits);
}
