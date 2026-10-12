export type NativeFullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
};

/** Native video fullscreen on iPhone; stage fullscreen for drawing controls. */
export async function requestMediaFullscreen(
  stage: HTMLElement,
  video: HTMLVideoElement | null,
  laserMode = false,
): Promise<'document' | 'viewport' | 'native-video'> {
  if (typeof stage.requestFullscreen === 'function') {
    try { await stage.requestFullscreen(); return 'document'; } catch { /* Try video next. */ }
  }
  if (!laserMode && video) {
    const native = video as NativeFullscreenVideo;
    if (typeof native.webkitEnterFullscreen === 'function') {
      try { native.webkitEnterFullscreen(); return 'native-video'; } catch { /* Try standard API. */ }
    }
    if (typeof video.requestFullscreen === 'function') {
      try { await video.requestFullscreen(); return 'document'; } catch { /* Try document next. */ }
    }
  }
  if (typeof document.documentElement.requestFullscreen === 'function') {
    try { await document.documentElement.requestFullscreen(); return 'document'; } catch { /* Viewport fallback. */ }
  }
  return 'viewport';
}
