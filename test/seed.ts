/**
 * The world seed tests make their land from. Fixed by default, so a failing run can be run
 * again and a pass means the same thing each time; `SEED=n` picks other land, and
 * `SEED=random` new land every run (the old behaviour, for looking for trouble). Printed
 * either way, so any failure can be rerun with `SEED=n`.
 */
export function testSeed(file: string, fallback = 7): number {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const s = env.SEED === 'random' ? Math.floor(Math.random() * 0x100000000) : Number(env.SEED ?? fallback) >>> 0;
  console.log(`${file}: world seed ${s} (SEED=${s} reruns this land)`);
  return s;
}
