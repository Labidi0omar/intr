// Phase-2 PRIMITIVES GALLERY.
//
// Renders every core component + every state on a single scrollable
// canvas so a reviewer can eyeball the design system in one pass.
// Nothing here talks to Supabase / router side effects — local state
// only. Delete the whole file when Phase 3 lands.
//
// Coverage (mirrors the Phase-2 prompt line-for-line):
//   Button        — primary / secondary / ghost × default / disabled / loading
//                   (pressed state demonstrated interactively on any button)
//   Input         — default / focused / error / disabled
//   Surface       — plain + toned (recovery indigo, at-risk amber, PR amber)
//   List row      — plain, with tone dot, with value, pressable
//   Header        — with back + eyebrow + right glyph (see PreviewHeader
//                   at the top of the screen; small variants inline below)
//   Tab bar       — segmented (single accent = teal)
//   Sheet / modal — bottom-anchored with handle + title, shown via a
//                   demo trigger button
//   Pill / chip   — filter states (default / active / disabled) + tone
//                   variants for status use
//   Accent legend — teal=action vs coral / amber / emerald / red / indigo
//                   = data meaning — the three-accent discipline made visible

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Button from '../../src/components/Button';
import Input from '../../src/components/Input';
import { useTheme } from '../../src/context/ThemeContext';
import { layout, typography } from '../../src/theme';
import { PREVIEW_ENABLED } from '../../src/constants/previewFlags';
import AccentLegend from '../../src/components/preview/AccentLegend';
import EffortScale, { type EffortLevel } from '../../src/components/preview/EffortScale';
import PreviewChip from '../../src/components/preview/PreviewChip';
import PreviewHeader from '../../src/components/preview/PreviewHeader';
import PreviewListRow from '../../src/components/preview/PreviewListRow';
import PreviewSheet from '../../src/components/preview/PreviewSheet';
import PreviewSurface from '../../src/components/preview/PreviewSurface';
import PreviewTabBar from '../../src/components/preview/PreviewTabBar';

export default function GalleryScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const styles = makeStyles(colors);

  // Local state for the interactive demos — no persistence, no side
  // effects. Reset on every mount.
  const [inputValue, setInputValue] = useState('');
  const [filter, setFilter] = useState('All');
  const [tab, setTab] = useState(0);
  const [effort, setEffort] = useState<EffortLevel | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  if (!__DEV__ || !PREVIEW_ENABLED) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.notAvailable}>
          <Text style={styles.notAvailableText}>Not available in this build.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const Section = ({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) => (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {description ? <Text style={styles.sectionDesc}>{description}</Text> : null}
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <PreviewHeader
        eyebrow="PRIMITIVES"
        title="Gallery"
        onBack={() => router.back()}
        divider
      />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* ── Type scale ─────────────────────────────────────────── */}
        <Section
          title="Type scale"
          description="Syne 700 headings, DM Sans 400/500 body. 32 / 22 / 16 / 14 / 12 / 11 — the semantic target."
        >
          <PreviewSurface>
            <Text style={[styles.tOne, { color: colors.textPrimary }]}>Heading 1 / 32</Text>
            <Text style={[styles.tTwo, { color: colors.textPrimary }]}>Heading 2 / 22</Text>
            <Text style={[styles.tBody, { color: colors.textPrimary }]}>Body 16 — the reading size.</Text>
            <Text style={[styles.tSm, { color: colors.textSecondary }]}>Small 14 — secondary readouts.</Text>
            <Text style={[styles.tXs, { color: colors.textMuted }]}>XS 12 — captions & metadata.</Text>
            <Text style={[styles.tXXs, { color: colors.textMuted }]}>XXS 11 — uppercase labels.</Text>
          </PreviewSurface>
        </Section>

        {/* ── Accent legend ──────────────────────────────────────── */}
        <Section
          title="Accent model"
          description="One action accent + locked semantic set. Teal is action-only; every other accent encodes meaning."
        >
          <PreviewSurface>
            <AccentLegend />
          </PreviewSurface>
        </Section>

        {/* ── Effort scale (signature move) ──────────────────────── */}
        <Section
          title="Effort scale — signature traffic-light"
          description="Easy=emerald, Solid=neutral, Hard=amber, Max=red. Load-bearing color coding; the one place multiple accents appear together."
        >
          <PreviewSurface>
            <EffortScale selected={effort} onSelect={setEffort} />
            <Text style={[styles.helper, { color: colors.textMuted, marginTop: layout.spacing.md }]}>
              {effort ? `Logged: ${effort.toUpperCase()}` : 'Tap a chip to log the last set.'}
            </Text>
          </PreviewSurface>
        </Section>

        {/* ── Button ─────────────────────────────────────────────── */}
        <Section title="Button" description="Primary uses the ONE action accent (teal). Secondary / ghost stay neutral.">
          <PreviewSurface>
            <View style={styles.buttonGrid}>
              <Text style={[styles.rowLabel, { color: colors.textMuted }]}>Default</Text>
              <Button title="Primary" onPress={() => {}} variant="primary" />
              <Button title="Secondary" onPress={() => {}} variant="secondary" />
              <Button title="Ghost" onPress={() => {}} variant="ghost" />

              <Text style={[styles.rowLabel, { color: colors.textMuted, marginTop: layout.spacing.md }]}>Disabled</Text>
              <Button title="Primary" onPress={() => {}} variant="primary" disabled />
              <Button title="Secondary" onPress={() => {}} variant="secondary" disabled />
              <Button title="Ghost" onPress={() => {}} variant="ghost" disabled />

              <Text style={[styles.rowLabel, { color: colors.textMuted, marginTop: layout.spacing.md }]}>Loading</Text>
              <Button title="Primary" onPress={() => {}} variant="primary" loading />
              <Button title="Secondary" onPress={() => {}} variant="secondary" loading />

              <Text style={[styles.helper, { color: colors.textMuted, marginTop: layout.spacing.md }]}>
                Tap any button to see the pressed state — 150ms opacity dip.
              </Text>
            </View>
          </PreviewSurface>
        </Section>

        {/* ── Input ──────────────────────────────────────────────── */}
        <Section title="Input">
          <PreviewSurface>
            <Input
              label="Default"
              placeholder="Placeholder text"
              value={inputValue}
              onChangeText={setInputValue}
            />
            <Input
              label="Focused (tap to see)"
              placeholder="Auto-focused pattern"
              value=""
              onChangeText={() => {}}
              autoFocus={false}
            />
            <Input
              label="Error"
              placeholder="wrong@"
              value="wrong@"
              onChangeText={() => {}}
              error="That doesn't look like an email."
            />
            <Input
              label="Disabled"
              placeholder="Not editable"
              value="Locked value"
              editable={false}
              onChangeText={() => {}}
            />
          </PreviewSurface>
        </Section>

        {/* ── Surface (with & without tone) ──────────────────────── */}
        <Section
          title="Surface — the lit-edge card (signature move)"
          description="Matte fill + 1px lit top edge + single soft shadow. `tone` = ambient glow, reserved for training-state cards."
        >
          <PreviewSurface>
            <Text style={styles.surfaceHeadline}>Plain matte surface</Text>
            <Text style={[styles.surfaceBody, { color: colors.textSecondary }]}>
              Default card treatment. Notice the 1px lit line across the top edge.
            </Text>
          </PreviewSurface>
          <PreviewSurface tone={colors.accentRest}>
            <Text style={styles.surfaceHeadline}>Toned — recovery (indigo)</Text>
            <Text style={[styles.surfaceBody, { color: colors.textSecondary }]}>
              The ambient glow encodes state ("you're recovering well"), not decoration.
            </Text>
          </PreviewSurface>
          <PreviewSurface tone={colors.accentAmber}>
            <Text style={styles.surfaceHeadline}>Toned — holding steady (amber)</Text>
            <Text style={[styles.surfaceBody, { color: colors.textSecondary }]}>
              Same primitive; the tone shifts by training-status semantics.
            </Text>
          </PreviewSurface>
        </Section>

        {/* ── List row ───────────────────────────────────────────── */}
        <Section
          title="List row — proposed shared primitive"
          description="Every screen re-invents this today. Dot uses the semantic set (never teal); value column right-aligned."
        >
          <PreviewSurface style={{ padding: 0 }}>
            <PreviewListRow title="Streak" value="12 days" divider />
            <PreviewListRow
              title="Training status"
              subtitle="Recovering well — pushed the deload out."
              tone={colors.accentPositive}
              value="Green"
              divider
            />
            <PreviewListRow
              title="Missed target zone"
              subtitle="Last 5 rated sets."
              tone={colors.accentAmber}
              value="2 / 5"
              divider
            />
            <PreviewListRow
              title="Change split"
              value=""
              onPress={() => {}}
            />
          </PreviewSurface>
        </Section>

        {/* ── Header (already visible at top; small demo of eyebrow) ── */}
        <Section
          title="Header — proposed shared primitive"
          description="The one at the top of this screen. Same primitive works with / without back button, eyebrow, and right glyph."
        >
          <PreviewSurface style={{ padding: 0 }}>
            <PreviewHeader title="Plain title" />
            <PreviewHeader title="With back" onBack={() => {}} divider />
            <PreviewHeader eyebrow="COACH'S CALL" title="Back squat" onBack={() => {}} rightGlyph="⇄" onRightPress={() => {}} divider />
          </PreviewSurface>
        </Section>

        {/* ── Tab bar ────────────────────────────────────────────── */}
        <Section
          title="Tab bar — segmented"
          description="Active tab uses the ONE action accent (teal). Inactive tabs are textMuted; no semantic accents here."
        >
          <PreviewSurface style={{ padding: layout.spacing.sm }}>
            <PreviewTabBar tabs={['Dashboard', 'Progress', 'History']} active={tab} onSelect={setTab} />
          </PreviewSurface>
        </Section>

        {/* ── Pill / chip ────────────────────────────────────────── */}
        <Section
          title="Pill / chip"
          description="Filter chips (default / active / disabled). Tone variants at the bottom demonstrate the semantic set for STATUS use — not filter selection."
        >
          <PreviewSurface>
            <View style={styles.chipRow}>
              {(['All', 'Chest', 'Back', 'Legs'] as const).map(opt => (
                <PreviewChip
                  key={opt}
                  label={opt}
                  active={filter === opt}
                  onPress={() => setFilter(opt)}
                />
              ))}
            </View>
            <View style={[styles.chipRow, { marginTop: layout.spacing.md }]}>
              <PreviewChip label="Disabled" active={false} onPress={() => {}} disabled />
              <PreviewChip label="Active + disabled" active onPress={() => {}} disabled />
            </View>
            <Text style={[styles.helper, { color: colors.textMuted, marginTop: layout.spacing.lg }]}>
              Status chips — semantic tones, non-selectable data readouts:
            </Text>
            <View style={[styles.chipRow, { marginTop: layout.spacing.sm }]}>
              <PreviewChip label="Streak" tone={colors.accentCoral} />
              <PreviewChip label="PR" tone={colors.accentAmber} />
              <PreviewChip label="Easy" tone={colors.accentPositive} />
              <PreviewChip label="Failed" tone={colors.accentRed} />
              <PreviewChip label="Rest" tone={colors.accentRest} />
            </View>
          </PreviewSurface>
        </Section>

        {/* ── Sheet / modal ──────────────────────────────────────── */}
        <Section
          title="Sheet / modal — proposed shared primitive"
          description="Bottom-anchored, matte fill, handle, lit top edge. Scrim dismiss + explicit action."
        >
          <PreviewSurface>
            <Button title="Open sheet" onPress={() => setSheetOpen(true)} variant="secondary" />
          </PreviewSurface>
        </Section>

        <Text style={[styles.footer, { color: colors.textMuted }]}>
          End of gallery. Toggle back to the hub with the ← arrow.
        </Text>
      </ScrollView>

      <Modal transparent visible={sheetOpen} animationType="fade" onRequestClose={() => setSheetOpen(false)}>
        <PreviewSheet title="Change split" onDismiss={() => setSheetOpen(false)}>
          <Text style={{ color: colors.textSecondary, fontFamily: typography.family.body, fontSize: typography.size.sm, lineHeight: 21, marginBottom: layout.spacing.lg }}>
            Tap outside the sheet to dismiss. In production, the body renders the
            action list (Full body / Upper-lower / PPL / Bro split).
          </Text>
          <Button title="Done" onPress={() => setSheetOpen(false)} variant="primary" />
        </PreviewSheet>
      </Modal>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) =>
  StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: colors.background,
    },
    notAvailable: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: layout.spacing.lg,
    },
    notAvailableText: {
      fontFamily: typography.family.body,
      fontSize: typography.size.md,
      color: colors.textMuted,
    },
    content: {
      padding: layout.spacing.lg,
      paddingBottom: layout.spacing.xxl,
    },
    section: {
      marginBottom: layout.spacing.xl,
    },
    sectionTitle: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.lg,
      color: colors.textPrimary,
      letterSpacing: -0.2,
      marginBottom: 4,
    },
    sectionDesc: {
      fontFamily: typography.family.body,
      fontSize: typography.size.xs,
      color: colors.textSecondary,
      lineHeight: 18,
      marginBottom: layout.spacing.md,
    },
    sectionBody: {
      gap: layout.spacing.sm,
    },
    tOne: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.xl,
      letterSpacing: -0.6,
      marginBottom: 6,
    },
    tTwo: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.lg,
      letterSpacing: -0.4,
      marginBottom: 6,
    },
    tBody: {
      fontFamily: typography.family.body,
      fontSize: typography.size.md,
      lineHeight: 22,
      marginBottom: 4,
    },
    tSm: {
      fontFamily: typography.family.body,
      fontSize: typography.size.sm,
      marginBottom: 4,
    },
    tXs: {
      fontFamily: typography.family.body,
      fontSize: typography.size.xs,
      marginBottom: 4,
    },
    tXXs: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.xxs,
      letterSpacing: 2,
      textTransform: 'uppercase',
    },
    surfaceHeadline: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.md,
      color: colors.textPrimary,
      letterSpacing: -0.2,
      marginBottom: 4,
    },
    surfaceBody: {
      fontFamily: typography.family.body,
      fontSize: typography.size.sm,
      lineHeight: 20,
    },
    buttonGrid: {
      gap: layout.spacing.sm,
    },
    rowLabel: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.xxs,
      letterSpacing: 2,
      textTransform: 'uppercase',
      marginBottom: 4,
    },
    helper: {
      fontFamily: typography.family.body,
      fontSize: typography.size.xs,
      lineHeight: 17,
    },
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: layout.spacing.xs,
    },
    footer: {
      fontFamily: typography.family.body,
      fontSize: typography.size.xxs,
      textAlign: 'center',
      letterSpacing: 0.4,
      marginTop: layout.spacing.lg,
    },
  });
