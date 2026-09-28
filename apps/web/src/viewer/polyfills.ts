/**
 * Méthodes « upsert » (ES2026) utilisées par pdf.js 6 mais absentes de navigateurs encore
 * répandus. Module importé AVANT pdf.js (les imports sont évalués dans l'ordre).
 */
type Upsert<K, V> = {
  getOrInsert(key: K, value: V): V;
  getOrInsertComputed(key: K, compute: (key: K) => V): V;
  has(key: K): boolean;
  get(key: K): V | undefined;
  set(key: K, value: V): unknown;
};

for (const proto of [Map.prototype, WeakMap.prototype] as unknown as Upsert<unknown, unknown>[]) {
  if (typeof proto.getOrInsert !== 'function') {
    Object.defineProperty(proto, 'getOrInsert', {
      configurable: true,
      writable: true,
      value(this: Upsert<unknown, unknown>, key: unknown, value: unknown) {
        if (!this.has(key)) this.set(key, value);
        return this.get(key);
      },
    });
  }
  if (typeof proto.getOrInsertComputed !== 'function') {
    Object.defineProperty(proto, 'getOrInsertComputed', {
      configurable: true,
      writable: true,
      value(this: Upsert<unknown, unknown>, key: unknown, compute: (key: unknown) => unknown) {
        if (!this.has(key)) this.set(key, compute(key));
        return this.get(key);
      },
    });
  }
}

export {};
