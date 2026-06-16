import {
  buildInstagramStoryBackgroundPayload,
  buildInstagramStoryStickerPayload,
  pickShareImageEncoding,
} from './instagramShare';

describe('pickShareImageEncoding', () => {
  it('iOS needs a base64 data URL for Stories', () => {
    expect(pickShareImageEncoding('ios')).toBe('base64');
  });

  it('Android accepts a file:// URI', () => {
    expect(pickShareImageEncoding('android')).toBe('fileUri');
  });

  it('non-iOS platforms default to the file URI path', () => {
    expect(pickShareImageEncoding('web')).toBe('fileUri');
    expect(pickShareImageEncoding('')).toBe('fileUri');
  });
});

describe('buildInstagramStoryStickerPayload', () => {
  it('sends the image as a STICKER, never a backgroundImage', () => {
    const payload = buildInstagramStoryStickerPayload({
      stickerImage: 'file:///tmp/card.png',
      appId: 'intr',
    });
    expect(payload.stickerImage).toBe('file:///tmp/card.png');
    // The behavior change: no backgroundImage key (that forces full-screen and
    // blocks the user's photo overlay).
    expect('backgroundImage' in payload).toBe(false);
    expect((payload as unknown as Record<string, unknown>).backgroundImage).toBeUndefined();
  });

  it('carries the appId through (required by Meta for iOS Stories)', () => {
    const payload = buildInstagramStoryStickerPayload({
      stickerImage: 'data:image/png;base64,AAAA',
      appId: 'real-fb-app-id',
    });
    expect(payload.appId).toBe('real-fb-app-id');
  });

  it('is sticker-ONLY: no background image and no backdrop colors (camera = background)', () => {
    const payload = buildInstagramStoryStickerPayload({
      stickerImage: 'file:///tmp/card.png',
      appId: 'intr',
    });
    // Exactly stickerImage + appId, nothing else — a backdrop of any kind
    // (image or colors) would force a fixed background and block the camera.
    expect(Object.keys(payload).sort()).toEqual(['appId', 'stickerImage']);
    const bag = payload as unknown as Record<string, unknown>;
    expect('backgroundImage' in bag).toBe(false);
    expect('backgroundTopColor' in bag).toBe(false);
    expect('backgroundBottomColor' in bag).toBe(false);
  });

  it('preserves the iOS base64 data URL as the sticker image unchanged', () => {
    const dataUrl = 'data:image/png;base64,SGVsbG8=';
    const payload = buildInstagramStoryStickerPayload({ stickerImage: dataUrl, appId: 'intr' });
    expect(payload.stickerImage).toBe(dataUrl);
  });
});

describe('buildInstagramStoryBackgroundPayload', () => {
  it('sends our composite as the background image (we own the canvas)', () => {
    const payload = buildInstagramStoryBackgroundPayload({
      backgroundImage: 'file:///tmp/composite.jpg',
      appId: 'intr',
    });
    // Exactly backgroundImage + appId — no sticker, no backdrop colors.
    expect(Object.keys(payload).sort()).toEqual(['appId', 'backgroundImage']);
    expect(payload.backgroundImage).toBe('file:///tmp/composite.jpg');
    expect(payload.appId).toBe('intr');
    const bag = payload as unknown as Record<string, unknown>;
    expect('stickerImage' in bag).toBe(false);
    expect('backgroundTopColor' in bag).toBe(false);
    expect('backgroundBottomColor' in bag).toBe(false);
  });

  it('preserves the iOS base64 data URL as the background image unchanged', () => {
    const dataUrl = 'data:image/jpeg;base64,SGVsbG8=';
    const payload = buildInstagramStoryBackgroundPayload({ backgroundImage: dataUrl, appId: 'real-fb-app-id' });
    expect(payload.backgroundImage).toBe(dataUrl);
    expect(payload.appId).toBe('real-fb-app-id');
  });
});
