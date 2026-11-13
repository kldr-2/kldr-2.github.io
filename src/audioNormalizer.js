/**
 * Audio Normalizer module for Loop Booth
 * Provides peak normalization with headroom protection, soft-knee saturation,
 * and noise floor threshold gating to keep audio takes balanced across all dubbers.
 */

export function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

export function linearToDb(linear) {
  if (!linear || linear <= 0.00001) return -100;
  return 20 * Math.log10(linear);
}

/**
 * Calculates absolute peak amplitude across all channels in an AudioBuffer
 * @param {AudioBuffer} audioBuffer
 * @returns {number} peak value between 0.0 and infinity
 */
export function calculatePeak(audioBuffer) {
  if (!audioBuffer) return 0;
  let maxPeak = 0;
  const numChannels = audioBuffer.numberOfChannels;
  for (let c = 0; c < numChannels; c++) {
    const data = audioBuffer.getChannelData(c);
    const len = data.length;
    for (let i = 0; i < len; i++) {
      const abs = Math.abs(data[i]);
      if (abs > maxPeak) maxPeak = abs;
    }
  }
  return maxPeak;
}

/**
 * Calculates RMS power across all channels in an AudioBuffer
 * @param {AudioBuffer} audioBuffer
 * @returns {number} rms value between 0.0 and 1.0
 */
export function calculateRms(audioBuffer) {
  if (!audioBuffer || audioBuffer.length === 0) return 0;
  let sumSquares = 0;
  let totalSamples = 0;
  const numChannels = audioBuffer.numberOfChannels;
  for (let c = 0; c < numChannels; c++) {
    const data = audioBuffer.getChannelData(c);
    const len = data.length;
    for (let i = 0; i < len; i++) {
      sumSquares += data[i] * data[i];
    }
    totalSamples += len;
  }
  return totalSamples > 0 ? Math.sqrt(sumSquares / totalSamples) : 0;
}

/**
 * Normalizes an AudioBuffer to target peak dB level.
 * Applies soft-knee limiting to prevent hard digital clipping.
 *
 * @param {AudioContext|BaseAudioContext} ctx
 * @param {AudioBuffer} audioBuffer
 * @param {number} targetPeakDb - e.g. -1.0 dBFS
 * @param {object} options
 * @param {number} [options.silenceThresholdDb=-42] - Ignore buffers below this level (avoid boosting room hiss)
 * @param {number} [options.maxBoostDb=18] - Maximum amplification gain in dB
 * @returns {{ buffer: AudioBuffer, gain: number, originalPeak: number, originalPeakDb: number, normalizedPeakDb: number, wasGated: boolean }}
 */
export function normalizeAudioBuffer(ctx, audioBuffer, targetPeakDb = -1.0, options = {}) {
  if (!audioBuffer) return { buffer: audioBuffer, gain: 1, originalPeak: 0, originalPeakDb: -100, normalizedPeakDb: -100, wasGated: true };

  const silenceThresholdDb = options.silenceThresholdDb ?? -42;
  const maxBoostDb = options.maxBoostDb ?? 18;

  const originalPeak = calculatePeak(audioBuffer);
  const originalPeakDb = linearToDb(originalPeak);
  const targetLinear = dbToLinear(targetPeakDb);
  const silenceFloorLinear = dbToLinear(silenceThresholdDb);
  const maxBoostLinear = dbToLinear(maxBoostDb);

  // If buffer is virtually silent or below threshold, don't blast noise
  if (originalPeak < silenceFloorLinear || originalPeak <= 0.0001) {
    return {
      buffer: audioBuffer,
      gain: 1.0,
      originalPeak,
      originalPeakDb,
      normalizedPeakDb: originalPeakDb,
      wasGated: true
    };
  }

  let rawGain = targetLinear / originalPeak;
  // Cap excessive boost to protect against noise amplification
  if (rawGain > maxBoostLinear) {
    rawGain = maxBoostLinear;
  }

  // Create a clean destination AudioBuffer
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;

  // Use ctx.createBuffer if available, or fallback constructor
  let newBuffer;
  if (ctx && typeof ctx.createBuffer === 'function') {
    newBuffer = ctx.createBuffer(numChannels, length, sampleRate);
  } else if (typeof AudioBuffer !== 'undefined') {
    newBuffer = new AudioBuffer({ numberOfChannels: numChannels, length, sampleRate });
  } else {
    return { buffer: audioBuffer, gain: rawGain, originalPeak, originalPeakDb, normalizedPeakDb: targetPeakDb, wasGated: false };
  }

  const softKneeThreshold = 0.95;
  const headroom = 1.0 - softKneeThreshold;

  for (let c = 0; c < numChannels; c++) {
    const srcData = audioBuffer.getChannelData(c);
    const destData = newBuffer.getChannelData(c);

    for (let i = 0; i < length; i++) {
      let val = srcData[i] * rawGain;

      // Soft-knee limiting for rare transient peaks
      if (val > softKneeThreshold) {
        val = softKneeThreshold + headroom * Math.tanh((val - softKneeThreshold) / headroom);
      } else if (val < -softKneeThreshold) {
        val = -softKneeThreshold + headroom * Math.tanh((val + softKneeThreshold) / headroom);
      }

      destData[i] = Math.max(-1.0, Math.min(1.0, val));
    }
  }

  const finalPeak = calculatePeak(newBuffer);
  const finalPeakDb = linearToDb(finalPeak);

  return {
    buffer: newBuffer,
    gain: rawGain,
    originalPeak,
    originalPeakDb,
    normalizedPeakDb: Math.round(finalPeakDb * 10) / 10,
    wasGated: false
  };
}
