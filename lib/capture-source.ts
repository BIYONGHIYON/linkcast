export type InputSource = 'capture' | 'screen';

/** Call synchronously from the click handler: screen capture needs user activation. */
export function acquireInput(devices: MediaDevices | undefined, source: InputSource, videoDeviceId?: string, audioDeviceId?: string) {
  const video: MediaTrackConstraints = {
    width: { ideal: 3840, max: 3840 },
    height: { ideal: 2160, max: 2160 },
    frameRate: { ideal: 60, max: 60 },
  };
  if (source === 'screen') {
    if (!devices?.getDisplayMedia) throw new Error('screen_capture_unsupported');
    // Do not constrain displaySurface: the picker offers screens, windows and tabs.
    return devices.getDisplayMedia({ video, audio: true });
  }
  if (!devices?.getUserMedia) throw new Error('capture_unsupported');
  return devices.getUserMedia({
    video: { ...video, ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {}) },
    audio: {
      ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}),
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    },
  });
}
