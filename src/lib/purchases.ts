import { Platform } from 'react-native';
import Purchases, {
  type PurchasesPackage,
  type CustomerInfo,
} from 'react-native-purchases';
import { useEffect, useState, useCallback } from 'react';
import { supabase } from './supabase';
import { reportSilent } from './errorReporting';
import { track, type EventProperties } from './analytics';

// ── Config ───────────────────────────────────────────────────────────
// Get these from RevenueCat dashboard → Project Settings → API Keys.
// Until you put real keys here, configure() no-ops and useEntitlement()
// always returns `false` — safe for development.

const RC_KEYS = {
  ios: process.env.EXPO_PUBLIC_RC_IOS_KEY ?? '',
  android: process.env.EXPO_PUBLIC_RC_ANDROID_KEY ?? '',
};

const PRO_ENTITLEMENT = 'pro';
let configured = false;

// ── Initialization ───────────────────────────────────────────────────

export async function configurePurchases(): Promise<void> {
  if (configured) return;

  const key = Platform.OS === 'ios' ? RC_KEYS.ios : RC_KEYS.android;
  if (!key) {
    // No key → operate in a "no entitlement, no error" mode. Safe for dev
    // builds where RevenueCat isn't wired yet.
    return;
  }

  try {
    await Purchases.configure({ apiKey: key });

    // Identify the user to RC as soon as we know who they are. RC tolerates
    // re-identification with the same UID, so wiring this in app init is fine.
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await Purchases.logIn(user.id);
    }

    configured = true;
  } catch (e) {
    // Silent — purchases failing should never block the app from loading.
    console.warn('[purchases] configure failed', e);
  }
}

// ── Entitlement hook ─────────────────────────────────────────────────

/**
 * Returns whether the current user has the `pro` entitlement.
 *
 *   const { isPro, loading } = useEntitlement();
 *
 * - During dev (no RC key): always returns `{ isPro: false, loading: false }`.
 * - After configure: subscribes to RC's `customerInfoUpdated` listener so the
 *   value flips automatically on purchase / restore / expiry.
 */
export function useEntitlement(): { isPro: boolean; loading: boolean } {
  const [isPro, setIsPro] = useState(false);
  const [loading, setLoading] = useState(true);

  const apply = useCallback((info: CustomerInfo | null) => {
    const active = !!info?.entitlements.active[PRO_ENTITLEMENT];
    setIsPro(active);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!configured) {
        if (!cancelled) {
          setIsPro(false);
          setLoading(false);
        }
        return;
      }
      try {
        const info = await Purchases.getCustomerInfo();
        if (!cancelled) apply(info);
      } catch (e) {
        reportSilent(e, 'purchases:getCustomerInfo');
        if (!cancelled) setIsPro(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    const listener = (info: CustomerInfo) => apply(info);
    if (configured) {
      Purchases.addCustomerInfoUpdateListener(listener);
    }

    return () => {
      cancelled = true;
      if (configured) {
        Purchases.removeCustomerInfoUpdateListener(listener);
      }
    };
  }, [apply]);

  return { isPro, loading };
}

// ── Catalog helpers (used by the paywall screen in Sprint 6) ─────────

export async function getOfferings(): Promise<PurchasesPackage[]> {
  if (!configured) return [];
  try {
    const offerings = await Purchases.getOfferings();
    return offerings.current?.availablePackages ?? [];
  } catch (e) {
    reportSilent(e, 'purchases:getOfferings');
    return [];
  }
}

export async function purchasePackage(pkg: PurchasesPackage): Promise<boolean> {
  if (!configured) return false;
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    const active = !!customerInfo.entitlements.active[PRO_ENTITLEMENT];
    if (active) {
      // Funnel: subscription_started fires on the FIRST successful purchase
      // call — paywall_shown should have been fired upstream when the user
      // saw the paywall (see trackPaywallShown below). product_id keys the
      // RC package identifier so the metrics_funnel view can split by SKU.
      track('subscription_started', {
        product_id: pkg.product?.identifier ?? pkg.identifier ?? null,
      });
    }
    return active;
  } catch (e: any) {
    if (e?.userCancelled) return false;
    console.warn('[purchases] purchase failed', e);
    return false;
  }
}

/**
 * Fire the `paywall_shown` funnel event. Callers: any UI component that
 * mounts a paywall surface should invoke this on first paint with the
 * reason that triggered the gate.
 *
 * No dedicated paywall screen exists at the time of writing — when one
 * lands, calling this from its `useEffect(() => …, [])` mount handler
 * completes the funnel. Until then, the event is only fired by an
 * upstream caller that knows the surface mounted; if no such caller
 * exists, `paywall_shown` will simply be silent in the funnel and the
 * downstream `subscription_started` event becomes a strict lower bound.
 */
export function trackPaywallShown(reason: NonNullable<EventProperties['paywall_reason']>): void {
  track('paywall_shown', { paywall_reason: reason });
}

export async function restorePurchases(): Promise<boolean> {
  if (!configured) return false;
  try {
    const info = await Purchases.restorePurchases();
    return !!info.entitlements.active[PRO_ENTITLEMENT];
  } catch (e) {
    reportSilent(e, 'purchases:restore');
    return false;
  }
}
