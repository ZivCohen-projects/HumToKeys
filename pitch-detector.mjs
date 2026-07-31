const defaults = {
  minHz: 75,
  maxHz: 1200,
  threshold: 0.14,
  minClarity: 0.72,
  minRms: 0.006,
};

export function estimatePitchYin(buffer, sampleRate, options = {}) {
  const settings = { ...defaults, ...options };
  const rms = getRms(buffer);
  if (!Number.isFinite(sampleRate) || rms < settings.minRms) return null;

  const minLag = Math.max(2, Math.floor(sampleRate / settings.maxHz));
  const maxLag = Math.min(
    Math.floor(sampleRate / settings.minHz),
    Math.floor(buffer.length / 2) - 2,
  );
  if (maxLag <= minLag) return null;

  const difference = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag += 1) {
    let sum = 0;
    const limit = buffer.length - lag;
    for (let index = 0; index < limit; index += 1) {
      const delta = buffer[index] - buffer[index + lag];
      sum += delta * delta;
    }
    difference[lag] = sum;
  }

  const normalizedDifference = new Float32Array(maxLag + 1);
  normalizedDifference[0] = 1;
  let cumulativeDifference = 0;
  for (let lag = 1; lag <= maxLag; lag += 1) {
    cumulativeDifference += difference[lag];
    normalizedDifference[lag] = cumulativeDifference
      ? (difference[lag] * lag) / cumulativeDifference
      : 1;
  }

  let bestLag = -1;
  for (let lag = minLag; lag < maxLag; lag += 1) {
    if (normalizedDifference[lag] >= settings.threshold) continue;
    while (lag + 1 <= maxLag && normalizedDifference[lag + 1] < normalizedDifference[lag]) {
      lag += 1;
    }
    bestLag = lag;
    break;
  }

  if (bestLag === -1) {
    let lowestDifference = Infinity;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      if (normalizedDifference[lag] < lowestDifference) {
        lowestDifference = normalizedDifference[lag];
        bestLag = lag;
      }
    }
  }

  const clarity = Math.max(0, Math.min(1, 1 - normalizedDifference[bestLag]));
  if (clarity < settings.minClarity) return null;

  const refinedLag = interpolateLag(normalizedDifference, bestLag);
  const frequency = sampleRate / refinedLag;
  if (!Number.isFinite(frequency) || frequency < settings.minHz || frequency > settings.maxHz) {
    return null;
  }

  return { frequency, clarity, rms, lag: refinedLag };
}

export function getRms(buffer) {
  let sum = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    sum += buffer[index] * buffer[index];
  }
  return Math.sqrt(sum / buffer.length);
}

function interpolateLag(values, lag) {
  if (lag <= 0 || lag >= values.length - 1) return lag;
  const before = values[lag - 1];
  const center = values[lag];
  const after = values[lag + 1];
  const denominator = 2 * (2 * center - before - after);
  if (Math.abs(denominator) < 1e-12) return lag;
  const shift = (after - before) / denominator;
  return lag + Math.max(-1, Math.min(1, shift));
}
