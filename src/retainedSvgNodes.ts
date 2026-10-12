import { reconcileKeyedOrder, type KeyedOrderHost } from "./keyedReconciler";

interface SvgNode {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

/** Retains SVG nodes/listeners, updating only changed attributes and order. */
export class RetainedSvgNodes<Node extends SvgNode> {
  private readonly nodes = new Map<string, Node>();
  private keys: string[] = [];

  begin(): void { this.keys = []; }

  get(key: string, create: () => Node, attributes: Record<string, string>): { node: Node; created: boolean } {
    let node = this.nodes.get(key);
    const created = !node;
    if (!node) { node = create(); this.nodes.set(key, node); }
    this.keys.push(key);
    for (const [name, value] of Object.entries(attributes)) {
      if (node.getAttribute(name) !== value) node.setAttribute(name, value);
    }
    return { node, created };
  }

  finish(host: KeyedOrderHost<Node>): void {
    const used = new Set(this.keys);
    for (const [key, node] of this.nodes) {
      if (!used.has(key)) { node.remove(); this.nodes.delete(key); }
    }
    reconcileKeyedOrder(this.keys, { ...host, find: (key) => this.nodes.get(key) ?? null });
  }
}
