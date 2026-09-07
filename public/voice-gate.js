class VoiceGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'threshold',
        defaultValue: 0.01,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate',
      },
    ];
  }
  constructor() {
    super();
    this.hold = 0;
    this.gain = 0;
    this.frames = 0;
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    let energy = 0;
    for (const value of input || []) energy += value * value;
    const rms = input?.length ? Math.sqrt(energy / input.length) : 0;
    if (rms >= parameters.threshold[0]) this.hold = sampleRate * 0.18;
    else this.hold = Math.max(0, this.hold - output.length);
    const target = this.hold > 0 ? 1 : 0;
    for (let i = 0; i < output.length; i++) {
      this.gain += (target - this.gain) * (target ? 0.03 : 0.002);
      output[i] = (input?.[i] || 0) * this.gain;
    }
    this.frames += output.length;
    if (this.frames >= sampleRate / 10) {
      this.frames = 0;
      this.port.postMessage({ level: rms, speaking: target === 1 });
    }
    return true;
  }
}
registerProcessor('voice-gate', VoiceGate);
