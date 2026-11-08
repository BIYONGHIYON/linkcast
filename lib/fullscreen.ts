export type NativeFullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
};

/** Keep the stage for overlays; native video fullscreen cannot show received strokes. */
export async function requestMediaFullscreen(
  stage: HTMLElement,
  video: HTMLVideoElement | null,
  preserveOverlay = false,
): Promise<'document' | 'viewport' | 'native-video'> {
  if (typeof stage.requestFullscreen === 'function') {
    try { await stage.requestFullscreen(); return 'document'; } catch { /* Try video next. */ }
  }
  if (!preserveOverlay && video) {
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
