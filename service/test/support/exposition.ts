/** A small parser for the Prometheus text format, enough for assertions. */
export type Sample = { name: string; labels: Record<string, string>; value: number };

export function parseExposition(text: string): { types: Map<string, string>; samples: Sample[] } {
  const types = new Map<string, string>();
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('# TYPE ')) {
      const [, , name, type] = line.split(' ');
      types.set(name!, type!);
    } else if (line && !line.startsWith('#')) {
      const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)/.exec(line);
      if (!match) continue;
      const labels: Record<string, string> = {};
      for (const pair of (match[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g))
        labels[pair[1]!] = pair[2]!;
      samples.push({ name: match[1]!, labels, value: Number(match[3]) });
    }
  }
  return { types, samples };
}

export const valueOf = (samples: Sample[], name: string, labels: Record<string, string> = {}) =>
  samples
    .filter((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v))
    .reduce((sum, s) => sum + s.value, 0);
