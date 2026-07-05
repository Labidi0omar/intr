// Phase-2 preview namespace flags.
//
// The Phase-2 gate builds the proposed design system as a real-RN preview
// so a human can view it on device and approve or send notes BEFORE any
// production screen is touched. Everything under app/preview/ + everything
// under src/components/preview/ gates on `PREVIEW_ENABLED && __DEV__`.
//
// Never flip PREVIEW_ENABLED off in a dev build unless you deliberately
// want the "not available" guard to fire — the value it gates is the
// visibility of the gallery, not any production behaviour. In release
// builds the guard is enforced by `__DEV__` regardless of this flag; a
// production APK that somehow deep-links to `/preview` still lands on the
// notice, never on the gallery. This flag exists so a future teammate can
// hide the preview locally without editing screen files (e.g. flip to
// false to confirm the guard renders correctly).
//
// This whole file gets deleted alongside app/preview/ + src/components/preview/
// when Phase 3 lands and the approved system moves into the production
// screens — no production code references it.

export const PREVIEW_ENABLED = true;
