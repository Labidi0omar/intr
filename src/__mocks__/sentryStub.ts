// Global stub for @sentry/react-native used by ts-jest. The real package
// ships ESM that ts-jest can't compile; tests don't actually need to verify
// Sentry calls (we cover that in pendingSync/planSync/coachHints with their
// own per-file mocks). This stub lets transitive imports of errorReporting.ts
// resolve without breaking jest collection.
//
// Wired in via package.json → jest.moduleNameMapper.

export const captureException = (() => {}) as unknown as (...args: unknown[]) => void;
export const captureMessage = (() => {}) as unknown as (...args: unknown[]) => void;
export const init = (() => {}) as unknown as (...args: unknown[]) => void;
export const setUser = (() => {}) as unknown as (...args: unknown[]) => void;
export const setTag = (() => {}) as unknown as (...args: unknown[]) => void;
export const setExtra = (() => {}) as unknown as (...args: unknown[]) => void;
export const wrap = <T>(x: T): T => x;

// Tests that need real behavior (assert captureException was called) re-mock
// the module themselves with jest.mock('@sentry/react-native', ...). Those
// per-file mocks shadow this stub for that file only.
