import { NpuLock, RknnModel } from '../src/rknn';

const modelPath = process.argv[2];
const runs = Number(process.argv[3] ?? 1);
if (!modelPath || !Number.isSafeInteger(runs) || runs < 1 || runs > 20_000) {
  throw new Error('usage: bun scripts/npu_smoke.ts MODEL.rknn [RUNS=1]');
}

const lock = new NpuLock();
const model = new RknnModel(modelPath, 1_500);
const input = new Uint8Array(640 * 640 * 3);
const started = performance.now();

try {
  lock.acquire();
  await model.open();
  const loadedMs = performance.now() - started;
  let output: Uint16Array<ArrayBufferLike> = new Uint16Array();
  const timings: number[] = [];
  for (let index = 0; index < runs; index++) {
    const inferenceStarted = performance.now();
    output = await model.infer(input);
    timings.push(performance.now() - inferenceStarted);
  }
  console.log(JSON.stringify({
    model: modelPath,
    outputElements: output.length,
    outputBytes: output.byteLength,
    loadMs: Math.round(loadedMs * 10) / 10,
    runs,
    averageInferenceMs: Math.round(timings.reduce((sum, value) => sum + value, 0) / timings.length * 10) / 10,
    minInferenceMs: Math.round(Math.min(...timings) * 10) / 10,
    maxInferenceMs: Math.round(Math.max(...timings) * 10) / 10,
  }));
} finally {
  model.close();
  lock.release();
}
