/**
 * Binary min-heap of integer ids keyed by float priority, with FIFO tie-breaking
 * (insertion sequence), which keeps priority-flood routing across flats stable.
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
    let i = this.n++;
    const s = this.seq++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] < key || (this.keys[p] === key && this.seqs[p] < s)) break;
      this.ids[i] = this.ids[p];
      this.keys[i] = this.keys[p];
      this.seqs[i] = this.seqs[p];
      i = p;
    }
    this.ids[i] = id;
    this.keys[i] = key;
    this.seqs[i] = s;
  }

  /** Key of the top element (call before `pop`). */
  peekKey(): number {
    return this.keys[0];
  }

  pop(): number {
    const top = this.ids[0];
    const n = --this.n;
    if (n > 0) {
      const id = this.ids[n];
      const key = this.keys[n];
      const s = this.seqs[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        const r = c + 1;
        if (r < n && (this.keys[r] < this.keys[c] || (this.keys[r] === this.keys[c] && this.seqs[r] < this.seqs[c]))) c = r;
        if (key < this.keys[c] || (key === this.keys[c] && s < this.seqs[c])) break;
        this.ids[i] = this.ids[c];
        this.keys[i] = this.keys[c];
        this.seqs[i] = this.seqs[c];
        i = c;
      }
      this.ids[i] = id;
      this.keys[i] = key;
      this.seqs[i] = s;
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
