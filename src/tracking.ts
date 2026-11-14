export type Box = { label: string; confidence: number; x: number; y: number; w: number; h: number };
export type Strategy = 'confidence' | 'area' | 'confidence + area';
export function chooseTarget(boxes: Box[], label: string, strategy: Strategy): Box | null {
  const matches = boxes.filter(b => b.label === label && b.w > 0 && b.h > 0);
  const largest = Math.max(1, ...matches.map(b => b.w * b.h));
  return matches.sort((a, b) => {
    const score = (v: Box) => strategy === 'confidence' ? v.confidence : strategy === 'area' ? v.w * v.h / largest : (v.confidence + v.w * v.h / largest) / 2;
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
    const dx = box.x + box.w / 2 - this.aimX * width;
    const dy = box.y + box.h / 2 - this.aimY * height;
    return {
      yaw: yawLimit || Math.abs(dx) < 12 ? 0 : Math.max(-1600, Math.min(1600, dx * 2.5)),
      pitch: Math.abs(dy) < 12 ? 0 : Math.max(-1000, Math.min(1000, dy * 2))
    };
  }
}
