/**
 * Min-heap (4-ary: shallower than binary, so fewer moves per pop) of integer ids keyed
 * by float priority, with FIFO tie-breaking (insertion sequence), which keeps
 * priority-flood routing across flats stable. (Key, sequence) orders entries
 * strictly, so the order of pops doesn't depend on the heap's layout.
 */
export class MinHeap {
  private ids: Int32Array;
  private keys: Float64Array;
  private seqs: Float64Array;
  private n = 0;
  private seq = 0;

  constructor(capacity = 1024) {
    this.ids = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
    this.seqs = new Float64Array(capacity);
  }

  get size(): number {
    return this.n;
  }

  push(id: number, key: number): void {
    if (this.n === this.ids.length) this.grow();
    const keys = this.keys;
    const seqs = this.seqs;
    const ids = this.ids;
    let i = this.n++;
    const s = this.seq++;
    while (i > 0) {
      const p = (i - 1) >> 2;
      const kp = keys[p];
      if (kp < key || (kp === key && seqs[p] < s)) break;
      ids[i] = ids[p];
      keys[i] = kp;
      seqs[i] = seqs[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
    seqs[i] = s;
  }

  /** Key of the top element (call before `pop`). */
  peekKey(): number {
    return this.keys[0];
  }

  pop(): number {
    const ids = this.ids;
    const keys = this.keys;
    const seqs = this.seqs;
    const top = ids[0];
    const n = --this.n;
    if (n > 0) {
      const id = ids[n];
      const key = keys[n];
      const s = seqs[n];
      let i = 0;
      for (;;) {
        const c0 = 4 * i + 1;
        if (c0 >= n) break;
        // Smallest of up to four children.
        let c = c0;
        let kc = keys[c0];
        let sc = seqs[c0];
        const end = c0 + 4 < n ? c0 + 4 : n;
        for (let x = c0 + 1; x < end; x++) {
          const kx = keys[x];
          if (kx < kc || (kx === kc && seqs[x] < sc)) {
            c = x;
            kc = kx;
            sc = seqs[x];
          }
        }
        if (key < kc || (key === kc && s < sc)) break;
        ids[i] = ids[c];
        keys[i] = kc;
        seqs[i] = sc;
        i = c;
      }
      ids[i] = id;
      keys[i] = key;
      seqs[i] = s;
    }
    return top;
  }

  private grow(): void {
    const cap = this.ids.length * 2;
    const ids = new Int32Array(cap);
    const keys = new Float64Array(cap);
    const seqs = new Float64Array(cap);
    ids.set(this.ids);
    keys.set(this.keys);
    seqs.set(this.seqs);
    this.ids = ids;
    this.keys = keys;
    this.seqs = seqs;
  }
}
