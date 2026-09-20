import type { QuoteLineItem } from "@/db/schema";

export function computeTotals(lineItems: QuoteLineItem[], taxRate: number) {
  const subtotal = lineItems.reduce((s, li) => s + li.quantity * li.unitPrice, 0);
  const tax = subtotal * (taxRate / 100);
  const total = subtotal + tax;
  return { subtotal: subtotal.toFixed(2), tax: tax.toFixed(2), total: total.toFixed(2) };
}
