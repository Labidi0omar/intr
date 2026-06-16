// Pure, native-free helpers for the Instagram Story share intent. Kept out of
// the React component — and deliberately free of any react-native /
// react-native-share import — so the encoding branch and the share payloads
// are unit-testable under the node/ts-jest setup (importing react-native-share
// pulls NativeModules and explodes in node).
//
// Two payload shapes:
//   • stickerImage  — IG owns the background (its camera); our card floats on
//     top as a sticker. Reliable for "shoot your own", but IG controls the
//     backdrop.
//   • backgroundImage — WE own the whole 1080×1920 canvas (composited in-app:
//     the user's photo or our brand backdrop + the card). Used by the
//     in-app composite share so the result is on-brand and deterministic.

export type ShareImageEncoding = 'base64' | 'fileUri';

/**
 * Which encoding the captured image needs for an IG Stories share.
 * iOS Stories requires a base64 data URL; Android accepts a file:// URI.
 * (react-native-view-shot returns a file path by default — we only
 * base64-encode on iOS.) Sticker images need the SAME encoding rule as the
 * old background image did, so this is shared by both paths.
 */
export function pickShareImageEncoding(os: string): ShareImageEncoding {
  return os === 'ios' ? 'base64' : 'fileUri';
}

export interface InstagramStoryStickerPayloadInput {
  /** The captured COMPACT sticker image (base64 data URL on iOS, file URI on
   *  Android). Goes to stickerImage — NEVER backgroundImage. */
  stickerImage: string;
  /** Required by Meta for iOS Stories. See the stub note in ShareCard. */
  appId: string;
}

/** The shareSingle fields for an IG Story sticker overlay, minus the `social`
 *  enum (which the caller injects from react-native-share). Sticker ONLY —
 *  no backgroundImage and no backdrop colors — so Instagram opens the camera
 *  as the background with our card overlaid. */
export interface InstagramStoryStickerPayload {
  stickerImage: string;
  appId: string;
}

/**
 * Build the sticker-overlay payload for RNShare.shareSingle. Sends ONLY the
 * sticker image (plus the required appId) — no backgroundImage and no
 * backgroundTopColor/backgroundBottomColor. Per Meta's Stories behavior, a
 * sticker-only share makes the user's CAMERA the background with the sticker
 * on top, so they can shoot a photo/video with the card on it. Any backdrop
 * (image or colors) would instead force a fixed background and block that.
 */
export function buildInstagramStoryStickerPayload(
  input: InstagramStoryStickerPayloadInput,
): InstagramStoryStickerPayload {
  return {
    stickerImage: input.stickerImage,
    appId: input.appId,
  };
}

export interface InstagramStoryBackgroundPayloadInput {
  /** The full 1080×1920 composite we built in-app (base64 data URL on iOS,
   *  file URI on Android — same encoding rule as everything else). */
  backgroundImage: string;
  /** Required by Meta for iOS Stories. See the stub note in ShareCard. */
  appId: string;
}

/** The shareSingle fields for an IG Story whose background is OUR composite —
 *  minus the `social` enum the caller injects. We own the canvas, so there are
 *  no backdrop colors and no stickerImage. */
export interface InstagramStoryBackgroundPayload {
  backgroundImage: string;
  appId: string;
}

/**
 * Build the background-image payload for RNShare.shareSingle. Sends our
 * in-app 1080×1920 composite as the Story background — reliable and on-brand,
 * never IG's default backdrop. No backgroundTopColor/backgroundBottomColor
 * (those only matter when you DON'T supply a background image).
 */
export function buildInstagramStoryBackgroundPayload(
  input: InstagramStoryBackgroundPayloadInput,
): InstagramStoryBackgroundPayload {
  return {
    backgroundImage: input.backgroundImage,
    appId: input.appId,
  };
}
