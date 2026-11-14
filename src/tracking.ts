export type Box = { label: string; confidence: number; x: number; y: number; width: number; height: number };
export type Strategy = 'confidence' | 'area' | 'confidence + area';
export function chooseTarget(boxes: Box[], label: string, strategy: Strategy): Box | null {
  const matches = boxes.filter(b => b.label === label && b.width > 0 && b.height > 0);
  const largest = Math.max(1, ...matches.map(b => b.width * b.height));
  return matches.toSorted((a, b) => {
    const score = (v: Box) => strategy === 'confidence' ? v.confidence : strategy === 'area' ? v.width * v.height / largest : (v.confidence + v.width * v.height / largest) / 2;
    return score(b) - score(a);
  })[0] ?? null;
}
export class Tracker {
  enabled = false; label = ''; strategy: Strategy = 'confidence + area';
  aimX = 0.5; aimY = 0.5; misses = 0;
  update(boxes: Box[], width: number, height: number, ageMs: number, yawLimit: boolean): { yaw: number; pitch: number } {
    if (!this.enabled || ageMs > 300) return { yaw: 0, pitch: 0 };
    const box = chooseTarget(boxes, this.label, this.strategy);
    if (!box) { this.misses++; return { yaw: 0, pitch: 0 }; }
    this.misses = 0;
    const dx = box.x + box.width / 2 - this.aimX * width;
    const dy = box.y + box.height / 2 - this.aimY * height;
    return {
      yaw: yawLimit || Math.abs(dx) < 12 ? 0 : Math.max(-1600, Math.min(1600, dx * 2.5)),
      pitch: Math.abs(dy) < 12 ? 0 : Math.max(-1000, Math.min(1000, dy * 2))
    };
  }
}
