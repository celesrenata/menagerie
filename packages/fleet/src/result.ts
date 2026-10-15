// A minimal explicit result type used across the fleet toolkit so each
// fallible boundary (parse, validate, compile, reconcile) returns a value the
// caller must branch on, rather than throwing. Mirrors the design's
// `Result<T, E>` in the component interfaces (design §1).

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })
