// Real-time ECG cleanup filter chain (RBJ biquads, Direct Form I).
// Runs on the edge server so noise can be tuned without reflashing the ESP32.
//
// Stages:
//   1. 0.5 Hz high-pass  -> removes baseline wander / electrode drift
//   2. 60 Hz notch       -> powerline hum (tuned to the MEASURED sample rate;
//                           the MAX30001 actually delivers ~497 SPS, not 512)
//   3. 35 Hz low-pass    -> muscle (EMG) hiss, preserves QRS shape

class Biquad {
  constructor(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
    this.reset();
  }
  reset() { this.x1 = this.x2 = this.y1 = this.y2 = 0; this.primed = false; }
  process(x) {
    if (!this.primed) { // start from steady state to avoid a startup spike
      this.x1 = this.x2 = x;
      const dc = (this.b0 + this.b1 + this.b2) / (1 + this.a1 + this.a2);
      this.y1 = this.y2 = Number.isFinite(dc) ? x * dc : 0;
      this.primed = true;
    }
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
            - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

function highpass(fs, f0, Q = 0.7071) {
  const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), a = Math.sin(w) / (2 * Q);
  return new Biquad((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + a, -2 * c, 1 - a);
}
function lowpass(fs, f0, Q = 0.7071) {
  const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), a = Math.sin(w) / (2 * Q);
  return new Biquad((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + a, -2 * c, 1 - a);
}
function notch(fs, f0, Q = 20) {
  const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), a = Math.sin(w) / (2 * Q);
  return new Biquad(1, -2 * c, 1, 1 + a, -2 * c, 1 - a);
}

class EcgCleaner {
  constructor(fs = 497, { hp = 0.5, mains = 60, lp = 35 } = {}) {
    this.stages = [highpass(fs, hp), notch(fs, mains, 20), lowpass(fs, lp)];
  }
  reset() { this.stages.forEach(s => s.reset()); }
  process(x) {
    let y = x;
    for (const s of this.stages) y = s.process(y);
    return parseFloat(y.toFixed(2));
  }
}

module.exports = { EcgCleaner };
