# Intr — Launch Checklist (Google Play, Android first)

Package: `com.intr.app` · EAS project: `249fe0c4-…` · Stack: Expo / Supabase / RevenueCat / Sentry

> ⚠️ Gotchas that block launch in non-obvious ways are marked **[GOTCHA]**.

## 1. Decide the permanent basics
- [ ] **Lock the package name** (applicationId) — *permanent after first publish, can never change.* See "Package name" decision.
- [ ] Confirm Android-first (iOS is only half-configured: no `bundleIdentifier`, duplicate `LSApplicationQueriesSchemes`).

## 2. Google Play Console
- [ ] **[GOTCHA] Data Safety form** — declare every data type (account, training data, journal free-text, diagnostics). Must match the privacy policy exactly or it's rejected.
- [ ] **[GOTCHA] Closed testing** — new personal dev accounts currently need ~12 testers opted in for ~14 continuous days before production access. Verify current rule; budget the 2 weeks.
- [ ] **[GOTCHA] Account-deletion URL** — Play requires a *web-accessible* deletion request page (not just in-app Profile → Delete Account). Host one on the legal site.
- [ ] Content rating (IARC) questionnaire
- [ ] Target audience / age (16+) + app category
- [ ] Store listing: feature graphic (1024×500), phone screenshots, short + full description, app icon
- [ ] Ads declaration: "No ads"

## 3. Build, signing & submit
- [ ] Production AAB: `eas build -p android --profile production`
- [ ] Enable **Play App Signing**
- [ ] **[GOTCHA]** Update `legal/.well-known/assetlinks.json` with the **SHA-256 of the Play-managed signing cert** (Console shows it) — else App Links won't verify
- [ ] Fill `submit.production` in `eas.json` (Play service-account JSON + track), then `eas submit`

## 4. Production config / secrets
- [ ] **[GOTCHA]** Confirm RevenueCat key, Supabase prod URL/anon key, and Sentry DSN are all set in the **EAS production profile** — `.env` currently has only the Sentry DSN
- [ ] RevenueCat: create subscription products in Play Console + link in RevenueCat; entitlements match `useEntitlement()`
- [ ] Sentry: DSN wired in the production build (no-ops without it)

## 5. Backend (Supabase)
- [ ] Reconcile migrations: `npm run db:push` so local files and prod history agree (connector pushes left odd version numbers)
- [ ] Confirm edge functions deployed to prod: `daily-reflection`, `replan-today`, `coach-recap`
- [ ] Advisors clean (no ERROR — currently true). Close the 2 WARNs: **enable leaked-password protection**; review `is_admin` SECURITY DEFINER
- [ ] Confirm funnel analytics events fire in prod (signup → … → subscription_started)

## 6. QA pass (real device, fresh account)
- [ ] Onboard (new split picker) → plan → train → PR shows → swap sticks → miss days → resume/skip, no loop
- [ ] Recovery gauge: band and reason agree on a couple of accounts
- [ ] Rest-day coach line shows (not yesterday's briefing)
- [ ] Offline: airplane mode → change split → reopen → plan reflects it → reconnect syncs
- [ ] Journal: one entry per day lock works

## 7. Legal
- [ ] Host `privacy-policy.html` + `terms-of-use.html` at a public URL
- [ ] Paste privacy URL into Play Console; link both in-app (Profile)
- [ ] Finalize `[[GOVERNING_COUNTRY]]` placeholder in terms
- [ ] Lawyer review of liability / governing-law sections (not legal advice)

## 8. Post-launch monitoring
- [ ] Sentry receiving events
- [ ] Funnel views (`metrics_funnel`, `metrics_prescription_trust`) populating
- [ ] Crash-free rate + first-week activation watched
