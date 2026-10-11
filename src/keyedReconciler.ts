export interface KeyedOrderHost<Node> {
  first(): Node | null;
  next(node: Node): Node | null;
  find(key: string): Node | null;
  insertBefore(node: Node, before: Node | null): void;
}

/** Reorders keyed nodes with the minimum forward scan; unchanged order performs zero DOM moves. */
export function reconcileKeyedOrder<Node>(desiredKeys: readonly string[], host: KeyedOrderHost<Node>): void {
  let cursor = host.first();
  for (const key of desiredKeys) {
    const node = host.find(key);
    if (!node) continue;
    if (node !== cursor) host.insertBefore(node, cursor);
    cursor = host.next(node);
  }
}
