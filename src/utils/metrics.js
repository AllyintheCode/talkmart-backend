const samples = new Map();
export function observe(name, value) {
  const values = samples.get(name) || [];
  values.push(value);
  if (values.length > 1000) values.shift();
  samples.set(name, values);
}
export function getMetrics() {
  return Object.fromEntries([...samples].map(([name, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const p = (n) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * n))] || 0;
    return [name, { samples: values.length, p50: p(0.5), p95: p(0.95), p99: p(0.99) }];
  }));
}
