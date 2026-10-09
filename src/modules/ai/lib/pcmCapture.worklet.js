// Runs on the audio thread. It only copies the microphone's first channel
// into 100 ms blocks and hands each one to the window, which resamples it.
class AnboPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is the context's rate, a global of this scope. The size
    // is kept apart from the block: posting a block transfers its buffer,
    // which leaves the old array with a length of 0.
    this.size = Math.max(1, Math.round(sampleRate / 10));
    this.block = new Float32Array(this.size);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, this.size - this.filled);
      this.block.set(channel.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === this.size) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("anbo-pcm-capture", AnboPcmCapture);
