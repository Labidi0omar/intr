import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import RNShare, { Social } from 'react-native-share';
import ViewShot from 'react-native-view-shot';
import { useTheme } from '../context/ThemeContext';
import { typography } from '../theme';
import {
  buildInstagramStoryBackgroundPayload,
  pickShareImageEncoding,
} from '../lib/instagramShare';
import {
  clampCardToCanvas,
  computeStoryCardLayout,
  mapEditorToCanvas,
} from '../lib/storyLayout';

// iOS Instagram/Facebook Stories sharing (background OR sticker) requires a real
// Facebook App ID registered with Meta. Without it, iOS silently refuses the
// Stories deep link and nothing opens. Sourced from EXPO_PUBLIC_FACEBOOK_APP_ID;
// set it in .env (and as an EAS secret) to the production numeric Meta App ID
// before any iOS release. Android background sharing works WITHOUT an appId, so a
// missing value only affects iOS (handled gracefully below — never a crash).
const IG_STORIES_APP_ID = process.env.EXPO_PUBLIC_FACEBOOK_APP_ID;

// ── Composite geometry ───────────────────────────────────────────────
// The final Story output is 1080×1920. We render the off-screen composite at a
// smaller LOGICAL size (keeps the capture bitmap cheap) and let ViewShot's
// width/height options upscale it to exactly 1080×1920. All placement math is
// done in CANVAS (1080-wide) space via the pure helpers, then scaled by R.
const CANVAS_W = 1080;
const CANVAS_H = 1920;
const RENDER_W = 360;
const RENDER_H = 640; // 9:16
const R = RENDER_W / CANVAS_W;
// The card's design width. Both the editor overlay and the composite render the
// SAME base card and scale it, so what the user places is what gets captured.
const CARD_BASE_W = 320;
// Safe zones (canvas px) IG's own UI covers — kept in sync with the editor
// guides and the computeStoryCardLayout defaults.
const TOP_SAFE = 250;
const BOTTOM_SAFE = 420;

interface ShareCardProps {
  muscleGroups: string[];   // e.g. ['CHEST', 'SHOULDERS']
  exerciseCount: number;    // total exercises completed
  energyScore: number;      // 1-5
  date: string;             // ISO date string
  onClose: () => void;
}

const ENERGY_LABEL_MAP: Record<number, string> = {
  1: 'DRAINED',
  2: 'LOW',
  3: 'SOLID',
  4: 'SHARP',
  5: 'LOCKED IN',
};

const OUTCOME_MAP: Record<number, string> = {
  1: 'FINISHED ANYWAY',
  2: 'SHOWED UP',
  3: 'GOT IT DONE',
  4: 'DOMINATED',
  5: 'CRUSHED',
};

type Busy = 'idle' | 'photo' | 'cardonly' | 'other';
type CompositeState = {
  bg: 'photo' | 'obsidian';
  photoUri: string | null;
  cardX: number; // canvas px (1080 space)
  cardY: number;
  cardW: number;
};

// ── The brand card itself (reused: menu preview, editor overlay, composite) ──
function CardVisual({
  colors,
  formattedDate,
  joinedMuscles,
  exerciseCount,
  energyLabel,
  outcomeLabel,
  onLayout,
}: {
  colors: any;
  formattedDate: string;
  joinedMuscles: string;
  exerciseCount: number;
  energyLabel: string;
  outcomeLabel: string;
  onLayout?: (e: any) => void;
}) {
  return (
    <View
      onLayout={onLayout}
      style={[styles.card, { backgroundColor: '#030304', borderColor: colors.border || '#22262A' }]}
    >
      <View style={styles.row1}>
        <Text style={[styles.intrText, { color: colors.textMuted }]}>INTR</Text>
        <Text style={[styles.dateText, { color: colors.textMuted }]}>{formattedDate}</Text>
      </View>

      <View style={[styles.divider, { backgroundColor: colors.border || '#22262A' }]} />

      <Text
        style={[styles.musclesText, { color: colors.textPrimary }]}
        numberOfLines={3}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
      >
        {joinedMuscles}
      </Text>

      <Text style={[styles.exercisesText, { color: colors.textSecondary }]}>
        {exerciseCount} {exerciseCount === 1 ? 'exercise' : 'exercises'}
      </Text>

      <View style={{ height: 24 }} />

      <Text style={[styles.energyLabelText, { color: colors.textMuted }]}>{energyLabel}</Text>

      <Text style={[styles.outcomeText, { color: colors.textPrimary }]} numberOfLines={2} adjustsFontSizeToFit>
        {outcomeLabel}
      </Text>
    </View>
  );
}

export default function ShareCard({
  muscleGroups,
  exerciseCount,
  energyScore,
  date,
  onClose,
}: ShareCardProps) {
  const { colors } = useTheme();
  const { width: winW, height: winH } = useWindowDimensions();

  const cardRef = useRef<any>(null);        // visible menu card → "More options"
  const compositeRef = useRef<any>(null);   // off-screen 1080×1920 capture target

  const [busy, setBusy] = useState<Busy>('idle');
  const [mode, setMode] = useState<'menu' | 'editor'>('menu');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  // Card height/width, measured from the real card so long titles don't clip
  // the layout math. Seeded with a sane default until the first onLayout.
  const [cardAspect, setCardAspect] = useState(1.2);
  // Editor placement, in editor px (top-left + width).
  const [card, setCard] = useState({ x: 0, y: 0, w: 0 });
  const [composite, setComposite] = useState<CompositeState | null>(null);

  // Deterministic capture gate. The off-screen photo Image fires onLoad once
  // it has actually decoded; we never capture the composite before then, so a
  // large photo can't snapshot blank (and fall back to a bare backdrop).
  // Keyed by uri so re-sharing the same photo resolves immediately.
  const loadedUriRef = useRef<string | null>(null);
  const photoWaiterRef = useRef<(() => void) | null>(null);

  const formattedDate = date ? date.replace(/-/g, '.') : '';
  const joinedMuscles = muscleGroups && muscleGroups.length > 0
    ? muscleGroups.join(' + ').toUpperCase()
    : 'WORKOUT';
  const energyLabel = ENERGY_LABEL_MAP[energyScore] || 'SOLID';
  const outcomeLabel = OUTCOME_MAP[energyScore] || 'GOT IT DONE';

  const cardProps = { colors, formattedDate, joinedMuscles, exerciseCount, energyLabel, outcomeLabel };

  // ── Editor canvas dimensions (largest 9:16 box that fits, room for buttons) ──
  const editorW = Math.max(
    180,
    Math.min(winW, Math.round((winH - 150) * (CANVAS_W / CANVAS_H))),
  );
  const editorH = Math.round(editorW * (CANVAS_H / CANVAS_W));
  const scaleCE = editorW / CANVAS_W; // canvas → editor

  const captureRef = async (ref: React.RefObject<any>): Promise<string | null> => {
    if (!ref.current) return null;
    try {
      return await ref.current.capture();
    } catch {
      return null;
    }
  };

  // ── Card transform helpers (scale the ONE base card to placement size) ──
  // Scale is applied around the view's center, so we offset the top-left to
  // land the SCALED top-left exactly on (x, y).
  const editorCardStyle = (x: number, y: number, w: number) => {
    const baseH = CARD_BASE_W * cardAspect;
    const h = w * cardAspect;
    return {
      position: 'absolute' as const,
      left: x + (w - CARD_BASE_W) / 2,
      top: y + (h - baseH) / 2,
      width: CARD_BASE_W,
      height: baseH,
      transform: [{ scale: w / CARD_BASE_W }],
    };
  };
  const compositeCardStyle = (cardX: number, cardY: number, cardW: number) => {
    const baseH = CARD_BASE_W * cardAspect;
    const w = cardW * R;
    const h = w * cardAspect;
    return {
      position: 'absolute' as const,
      left: cardX * R + (w - CARD_BASE_W) / 2,
      top: cardY * R + (h - baseH) / 2,
      width: CARD_BASE_W,
      height: baseH,
      transform: [{ scale: w / CARD_BASE_W }],
    };
  };

  // ── Drag + pinch (gesture-handler, JS-thread via runOnJS; no worklets) ──
  const minCardW = Math.max(80, editorW * 0.3);
  const maxCardW = editorW;
  const clampW = (w: number) => Math.max(minCardW, Math.min(maxCardW, w));
  const clampState = (c: { x: number; y: number; w: number }) => {
    const { x, y } = clampCardToCanvas({ x: c.x, y: c.y, w: c.w, h: c.w * cardAspect, editorW, editorH });
    return { x, y, w: c.w };
  };
  const lastScale = useRef(1);
  const panGesture = Gesture.Pan()
    .onChange((e) => {
      setCard((c) => clampState({ ...c, x: c.x + e.changeX, y: c.y + e.changeY }));
    })
    .runOnJS(true);
  const pinchGesture = Gesture.Pinch()
    .onStart(() => {
      lastScale.current = 1;
    })
    .onChange((e) => {
      const factor = e.scale / (lastScale.current || 1);
      lastScale.current = e.scale;
      setCard((c) => {
        const newW = clampW(c.w * factor);
        const dw = newW - c.w;
        const dh = dw * cardAspect;
        // Pinch around the card's center: shift top-left by half the delta.
        return clampState({ x: c.x - dw / 2, y: c.y - dh / 2, w: newW });
      });
    })
    .runOnJS(true);
  const composedGesture = Gesture.Simultaneous(panGesture, pinchGesture);

  // ── Photo picking ─────────────────────────────────────────────────
  const enterEditorWithPhoto = (uri: string) => {
    const layout = computeStoryCardLayout({
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      cardAspect,
      topSafe: TOP_SAFE,
      bottomSafe: BOTTOM_SAFE,
    });
    setCard({
      x: Math.round(layout.cardX * scaleCE),
      y: Math.round(layout.cardTop * scaleCE),
      w: Math.round(layout.cardW * scaleCE),
    });
    setPhotoUri(uri);
    setMode('editor');
  };

  const launchLibrary = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Photos access needed', 'Allow photo access in Settings to place your card on a photo.');
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({ quality: 1 });
      if (res.canceled || !res.assets?.[0]?.uri) return;
      enterEditorWithPhoto(res.assets[0].uri);
    } catch (e: any) {
      Alert.alert('Could not open photos', String(e?.message ?? e));
    }
  };

  const launchCamera = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Camera access needed', 'Allow camera access in Settings to shoot a photo for your card.');
        return;
      }
      const res = await ImagePicker.launchCameraAsync({ quality: 1 });
      if (res.canceled || !res.assets?.[0]?.uri) return;
      enterEditorWithPhoto(res.assets[0].uri);
    } catch (e: any) {
      Alert.alert('Could not open camera', String(e?.message ?? e));
    }
  };

  const pickPhoto = () => {
    if (busy !== 'idle') return;
    Alert.alert('Card on a photo', 'Choose a photo to place your card on.', [
      { text: 'Take photo', onPress: () => void launchCamera() },
      { text: 'Choose from library', onPress: () => void launchLibrary() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  // ── Composite capture + share (both paths) ─────────────────────────
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // Called from the off-screen composite Image's onLoad once decoded.
  const onCompositePhotoLoaded = (uri?: string | null) => {
    loadedUriRef.current = uri ?? null;
    const resolve = photoWaiterRef.current;
    photoWaiterRef.current = null;
    if (resolve) resolve();
  };

  // Resolve when the composite photo for `uri` has decoded (or after a safety
  // timeout so we never hang). If it already loaded, resolve immediately.
  const waitForCompositePhoto = (uri: string, timeoutMs = 6000) =>
    new Promise<void>((resolve) => {
      if (loadedUriRef.current === uri) {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        photoWaiterRef.current = null;
        resolve();
      };
      photoWaiterRef.current = finish;
      setTimeout(finish, timeoutMs);
    });

  const onShareError = (e: any) => {
    const msg = String(e?.message ?? e);
    if (msg.toLowerCase().includes('cancel')) {
      // user dismissed — silent
    } else if (msg.toLowerCase().includes('not installed') || msg.toLowerCase().includes('no app')) {
      Alert.alert('Instagram not found', 'Install Instagram, then try again.');
    } else {
      console.warn('[ShareCard] IG composite share failed:', msg);
      Alert.alert('Share failed', msg || 'Could not open Instagram. Try "More options".');
    }
  };

  const compositeShare = async (busyKey: Busy, comp: CompositeState) => {
    if (busy !== 'idle') return;
    // iOS Stories sharing is a no-op without a Facebook App ID. Bail gracefully
    // before attempting the share (rather than letting IG silently refuse the
    // deep link) — same "not available" message the user would otherwise see.
    // Android doesn't need an appId, so it proceeds regardless.
    if (Platform.OS === 'ios' && !IG_STORIES_APP_ID) {
      Alert.alert('Instagram Stories unavailable', 'Sharing to Instagram Stories isn’t available right now. Try "More options".');
      return;
    }
    setBusy(busyKey);
    try {
      // Drive the off-screen 1080×1920 composite, then capture it as the Story
      // background. For the photo path we GATE on the Image's onLoad (not a
      // fixed delay) so a large photo can't snapshot blank.
      setComposite(comp);
      if (comp.bg === 'photo' && comp.photoUri) {
        await wait(0); // let React mount the Image with the new source
        await waitForCompositePhoto(comp.photoUri);
        await wait(80); // one paint after decode so the bitmap is composited
      } else {
        await wait(140); // card-only: just views, a frame is enough
      }

      const uri = await captureRef(compositeRef);
      if (!uri) {
        Alert.alert('Capture failed', 'Could not generate the share image. Try again.');
        return;
      }

      // iOS Stories needs a base64 data URL; Android accepts a file:// URI.
      const backgroundImage = pickShareImageEncoding(Platform.OS) === 'base64'
        ? await toBase64DataUrl(uri)
        : uri;
      if (!backgroundImage) {
        Alert.alert('Capture failed', 'Could not encode the share image.');
        return;
      }

      await RNShare.shareSingle({
        social: Social.InstagramStories,
        // WE own the canvas: pass our composite as the background image. No
        // backdrop colors, no sticker — reliable, on-brand, never IG's default.
        // appId is required by Meta on iOS (guarded as present above); Android
        // ignores it for the Stories deep link, so '' there is harmless.
        ...buildInstagramStoryBackgroundPayload({
          backgroundImage,
          appId: IG_STORIES_APP_ID ?? '',
        }),
      });

      onClose();
    } catch (e: any) {
      onShareError(e);
    } finally {
      setBusy('idle');
    }
  };

  // "Card only" — branded obsidian backdrop, card at the default centered spot.
  const shareCardOnly = () => {
    const layout = computeStoryCardLayout({
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      cardAspect,
      topSafe: TOP_SAFE,
      bottomSafe: BOTTOM_SAFE,
    });
    void compositeShare('cardonly', {
      bg: 'obsidian',
      photoUri: null,
      cardX: layout.cardX,
      cardY: layout.cardTop,
      cardW: layout.cardW,
    });
  };

  // "Card on a photo" — map the user's editor placement to canvas, then share.
  const confirmEditor = () => {
    if (!photoUri) return;
    const mapped = mapEditorToCanvas({
      editorW,
      canvasW: CANVAS_W,
      cardEditorX: card.x,
      cardEditorY: card.y,
      cardEditorW: card.w,
    });
    void compositeShare('photo', {
      bg: 'photo',
      photoUri,
      cardX: mapped.cardX,
      cardY: mapped.cardY,
      cardW: mapped.cardW,
    });
  };

  const cancelEditor = () => {
    if (busy !== 'idle') return;
    setMode('menu');
    setPhotoUri(null);
  };

  // ── Generic system share sheet ("More options") ───────────────────
  const handleShareGeneric = async () => {
    if (busy !== 'idle') return;
    setBusy('other');
    try {
      const uri = await captureRef(cardRef);
      if (!uri) {
        Alert.alert('Capture failed', 'Could not generate the share image. Try again.');
        return;
      }
      await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share your session' });
      onClose();
    } catch {
      onClose();
    } finally {
      setBusy('idle');
    }
  };

  return (
    <Modal transparent visible animationType="fade" onRequestClose={mode === 'editor' ? cancelEditor : onClose}>
      {/* RN <Modal> renders into its OWN native view hierarchy, which the
          app-root GestureHandlerRootView (app/_layout.tsx) does not cover — so
          gesture-handler gestures inside it get no touches unless we mount a
          fresh root here. Without this the editor card won't drag or pinch. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Always-mounted, off-screen composite — the 1080×1920 capture target.
          Guides/UI are NEVER part of this view, so they can't end up in the
          shared image. ViewShot scales it to exactly 1080×1920. */}
      <View style={styles.offscreen} pointerEvents="none">
        <ViewShot
          ref={compositeRef}
          options={{ width: CANVAS_W, height: CANVAS_H, format: 'jpg', quality: 0.95, result: 'tmpfile' }}
          style={[styles.composite, { width: RENDER_W, height: RENDER_H }]}
        >
          {composite?.bg === 'photo' && composite.photoUri ? (
            <Image
              source={{ uri: composite.photoUri }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
              fadeDuration={0}
              onLoad={() => onCompositePhotoLoaded(composite.photoUri)}
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: '#070708' }]}>
              {/* Subtle on-brand glow so "card only" isn't a flat rectangle. */}
              <View style={[styles.compositeGlow, { backgroundColor: colors.accentTeal }]} />
            </View>
          )}
          {composite && (
            <View style={compositeCardStyle(composite.cardX, composite.cardY, composite.cardW)}>
              <CardVisual {...cardProps} />
            </View>
          )}
        </ViewShot>
      </View>

      {/* Hidden measuring instance → real card aspect for the layout math. */}
      <View style={styles.offscreen} pointerEvents="none">
        <CardVisual
          {...cardProps}
          onLayout={(e: any) => {
            const { width, height } = e.nativeEvent.layout;
            if (width > 0 && height > 0) {
              const next = height / width;
              setCardAspect((prev) => (Math.abs(prev - next) > 0.01 ? next : prev));
            }
          }}
        />
      </View>

      {mode === 'editor' ? (
        <View style={styles.editorRoot}>
          <Text style={[styles.editorHint, { color: colors.textSecondary }]}>
            Drag to move · pinch to resize
          </Text>
          <View style={[styles.editorCanvas, { width: editorW, height: editorH, borderColor: colors.border || '#22262A' }]}>
            {photoUri && (
              <Image source={{ uri: photoUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
            )}

            <GestureDetector gesture={composedGesture}>
              <View style={editorCardStyle(card.x, card.y, card.w)}>
                <CardVisual {...cardProps} />
              </View>
            </GestureDetector>

            {/* Faint safe-zone guides (NOT captured — overlay only). */}
            <View pointerEvents="none" style={[styles.safeBand, { top: 0, height: TOP_SAFE * scaleCE }]}>
              <View style={styles.safeLineBottom} />
            </View>
            <View pointerEvents="none" style={[styles.safeBand, { bottom: 0, height: BOTTOM_SAFE * scaleCE }]}>
              <View style={styles.safeLineTop} />
            </View>
          </View>

          <View style={styles.editorButtons}>
            <TouchableOpacity
              style={[styles.editorBtn, { borderColor: colors.border || '#22262A' }]}
              onPress={cancelEditor}
              activeOpacity={0.8}
              disabled={busy !== 'idle'}
            >
              <Text style={[styles.editorBtnText, { color: colors.textPrimary }]}>BACK</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.editorBtn, styles.editorBtnPrimary, { backgroundColor: colors.accentTeal }]}
              onPress={confirmEditor}
              activeOpacity={0.85}
              disabled={busy !== 'idle'}
            >
              {busy === 'photo' ? (
                <ActivityIndicator size="small" color={colors.background} />
              ) : (
                <Text style={[styles.editorBtnText, { color: colors.background }]}>SHARE TO STORY</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.overlay}>
          <View style={styles.container}>
            {/* Visible card preview — also the "More options" capture target. */}
            <ViewShot
              ref={cardRef}
              options={{ format: 'png', quality: 1.0, result: 'tmpfile' }}
            >
              <CardVisual {...cardProps} />
            </ViewShot>

            {/* Primary: card on a photo (interactive placement) */}
            <TouchableOpacity
              style={[styles.igButton, { backgroundColor: colors.accentTeal }]}
              onPress={pickPhoto}
              activeOpacity={0.85}
              disabled={busy !== 'idle'}
            >
              <Text style={[styles.igButtonText, { color: colors.background }]}>CARD ON A PHOTO</Text>
            </TouchableOpacity>

            {/* Secondary: card only (branded backdrop, no editor) */}
            <TouchableOpacity
              style={[styles.secondaryButton, { borderColor: colors.border || '#22262A' }]}
              onPress={shareCardOnly}
              activeOpacity={0.8}
              disabled={busy !== 'idle'}
            >
              {busy === 'cardonly' ? (
                <ActivityIndicator size="small" color={colors.textPrimary} />
              ) : (
                <Text style={[styles.secondaryButtonText, { color: colors.textPrimary }]}>CARD ONLY</Text>
              )}
            </TouchableOpacity>

            {/* Tertiary: generic system share */}
            <TouchableOpacity
              style={styles.linkButton}
              onPress={handleShareGeneric}
              activeOpacity={0.8}
              disabled={busy !== 'idle'}
            >
              {busy === 'other' ? (
                <ActivityIndicator size="small" color={colors.textMuted} />
              ) : (
                <Text style={[styles.secondaryButtonText, { color: colors.textMuted }]}>MORE OPTIONS</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={styles.closeButton} onPress={onClose} activeOpacity={0.7} disabled={busy !== 'idle'}>
              <Text style={[styles.closeButtonText, { color: colors.textMuted }]}>DISMISS</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      </GestureHandlerRootView>
    </Modal>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

async function toBase64DataUrl(fileUri: string): Promise<string | null> {
  try {
    const FileSystem = await import('expo-file-system/legacy');
    const base64 = await (FileSystem as any).readAsStringAsync(fileUri, { encoding: 'base64' });
    return `data:image/jpeg;base64,${base64}`;
  } catch {
    try {
      // Fall back to direct fetch (works on Android file://)
      const res = await fetch(fileUri);
      const blob = await res.blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    alignItems: 'center',
  },
  card: {
    width: CARD_BASE_W,
    padding: 32,
    borderWidth: 1,
    borderRadius: 16,
  },
  // Off-screen render targets (composite + aspect measuring) — laid out but
  // never shown to the user.
  offscreen: {
    position: 'absolute',
    left: -10000,
    top: 0,
  },
  composite: {
    overflow: 'hidden',
  },
  compositeGlow: {
    position: 'absolute',
    alignSelf: 'center',
    top: RENDER_H * 0.42,
    width: RENDER_W * 0.9,
    height: RENDER_W * 0.9,
    borderRadius: RENDER_W * 0.45,
    opacity: 0.12,
  },
  // ── Editor ───────────────────────────────────────────────────────
  editorRoot: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
  },
  editorHint: {
    fontFamily: typography.family.bodyMedium,
    fontSize: 12,
    letterSpacing: 1,
    marginBottom: 12,
    textTransform: 'uppercase',
  },
  editorCanvas: {
    overflow: 'hidden',
    borderRadius: 14,
    borderWidth: 1,
    backgroundColor: '#070708',
  },
  // Transparent spacer that positions a single hairline at the safe-zone
  // boundary — no heavy filled band that reads as a black bar over the photo.
  safeBand: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: 'transparent',
  },
  safeLineBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  safeLineTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  editorButtons: {
    flexDirection: 'row',
    marginTop: 16,
    gap: 12,
  },
  editorBtn: {
    minWidth: 130,
    height: 50,
    borderWidth: 1,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 18,
  },
  editorBtnPrimary: {
    borderWidth: 0,
  },
  editorBtnText: {
    fontFamily: typography.family.heading,
    fontSize: 13,
    letterSpacing: 1,
  },
  // ── Card content ─────────────────────────────────────────────────
  row1: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  intrText: {
    fontFamily: typography.family.heading,
    fontSize: 12,
    letterSpacing: 2,
  },
  dateText: {
    fontFamily: typography.family.heading,
    fontSize: 12,
    letterSpacing: 2,
  },
  divider: {
    height: 1,
    width: '100%',
    marginVertical: 16,
  },
  musclesText: {
    fontFamily: typography.family.heading,
    fontSize: 22,
    textTransform: 'uppercase',
  },
  exercisesText: {
    fontFamily: typography.family.body,
    fontSize: 13,
    marginTop: 8,
  },
  energyLabelText: {
    fontFamily: typography.family.body,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  outcomeText: {
    fontFamily: typography.family.heading,
    fontSize: 28,
    textTransform: 'uppercase',
    marginTop: 4,
  },
  // ── Menu buttons ─────────────────────────────────────────────────
  igButton: {
    width: 320,
    height: 52,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 24,
  },
  igButtonText: {
    fontFamily: typography.family.heading,
    fontSize: 13,
    letterSpacing: 1,
  },
  secondaryButton: {
    width: 320,
    height: 44,
    borderWidth: 1,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 10,
  },
  secondaryButtonText: {
    fontFamily: typography.family.bodyMedium,
    fontSize: 12,
    letterSpacing: 1,
  },
  linkButton: {
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  closeButton: {
    marginTop: 12,
    paddingVertical: 8,
  },
  closeButtonText: {
    fontFamily: typography.family.bodyMedium,
    fontSize: 11,
    letterSpacing: 1,
  },
});
