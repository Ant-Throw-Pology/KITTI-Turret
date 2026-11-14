export type FrameHeader = { seq: number; timestamp: number; jpeg: ArrayBuffer };
export type DetectionBox = { label: string; confidence: number; x: number; y: number; width?: number; height?: number; w?: number; h?: number; classId?: number };
export type DetectionPacket = { type?: string; seq?: number; sequence?: number; timestamp?: number; width?: number; height?: number; boxes?: DetectionBox[] };
export type TargetOption = { value: string; label: string; classId?: number; tagId?: number; allTags?: boolean };

export const YOLO_LABELS = [
  'person','bicycle','car','motorcycle','airplane','bus','train','truck','boat','traffic light',
  'fire hydrant','stop sign','parking meter','bench','bird','cat','dog','horse','sheep','cow',
  'elephant','bear','zebra','giraffe','backpack','umbrella','handbag','tie','suitcase','frisbee',
  'skis','snowboard','sports ball','kite','baseball bat','baseball glove','skateboard','surfboard','tennis racket','bottle',
  'wine glass','cup','fork','knife','spoon','bowl','banana','apple','sandwich','orange',
  'broccoli','carrot','hot dog','pizza','donut','cake','chair','couch','potted plant','bed',
  'dining table','toilet','tv','laptop','mouse','remote','keyboard','cell phone','microwave','oven',
  'toaster','sink','refrigerator','book','clock','vase','scissors','teddy bear','hair drier','toothbrush'
] as const;

export const BASELINE_CLASS_IDS = new Set([0, 15, 16]);

export function parseJpegFrame(data: ArrayBuffer): FrameHeader {
  if (data.byteLength < 12) throw new Error('short frame');
  const view = new DataView(data);
  return { seq: view.getUint32(0, true), timestamp: Number(view.getBigUint64(4, true)), jpeg: data.slice(12) };
}

export function detectionSequence(packet: DetectionPacket): number | undefined {
  return packet.seq ?? packet.sequence;
}

export function matchDetectionsToFrame(frame: { seq: number; timestamp: number }, packets: readonly DetectionPacket[], maxAgeMs = 300): DetectionPacket | undefined {
  for (let i = packets.length - 1; i >= 0; i--) if (detectionSequence(packets[i]!) === frame.seq) return packets[i];
  let best: DetectionPacket | undefined, bestDelta = maxAgeMs + 1;
  for (const packet of packets) {
    if (packet.timestamp === undefined) continue;
    const delta = Math.abs(packet.timestamp - frame.timestamp);
    if (delta <= maxAgeMs && delta < bestDelta) { best = packet; bestDelta = delta; }
  }
  return best;
}

export function boxSize(box: DetectionBox): { width: number; height: number } {
  return { width: box.width ?? box.w ?? 0, height: box.height ?? box.h ?? 0 };
}

export function boxStyle(box: DetectionBox, frameWidth: number, frameHeight: number): Partial<CSSStyleDeclaration> {
  const { width, height } = boxSize(box);
  return {
    left: `${box.x / frameWidth * 100}%`,
    top: `${box.y / frameHeight * 100}%`,
    width: `${width / frameWidth * 100}%`,
    height: `${height / frameHeight * 100}%`,
  };
}

export function targetOptions(): TargetOption[] {
  return [
    { value: 'All AprilTags', label: 'All AprilTags', allTags: true },
    ...YOLO_LABELS.map((label, classId) => ({ value: label, label: `YOLO ${classId}: ${label}`, classId })),
    ...Array.from({ length: 587 }, (_, tagId) => ({ value: `tag:${tagId}`, label: `AprilTag ${tagId}`, tagId })),
  ];
}

export function classIdsForTarget(target: string, baseline: ReadonlySet<number> = BASELINE_CLASS_IDS): number[] {
  const ids = new Set(baseline);
  const classId = YOLO_LABELS.indexOf(target as typeof YOLO_LABELS[number]);
  if (classId >= 0) ids.add(classId);
  return [...ids].sort((a, b) => a - b);
}
