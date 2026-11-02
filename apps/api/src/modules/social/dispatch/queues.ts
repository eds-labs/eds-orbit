// The social module's queue classes (ADR 0020 §7, S5), apart from their
// handlers so every dispatch file can name them without import cycles.

export const DISPATCH = "social_dispatch";
export const DELIVER = "social_deliver";
export const RECONCILE = "social_reconcile";
