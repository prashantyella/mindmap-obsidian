export interface CommitInputLike {
  value: string;
  addEventListener(type: "blur" | "keydown", listener: (event: { key?: string; preventDefault?(): void }) => void): void;
  blur?(): void;
}

/**
 * A commit is successful unless it explicitly returns `false` or throws/
 * rejects. `void`/`undefined` (including a resolved `Promise<void>`) counts
 * as success, matching the common case of a commit callback that either
 * completes or throws.
 */
export type CommitResult = void | boolean | Promise<void | boolean>;

/**
 * Commits a text input's value on blur or Enter, never on every keystroke.
 *
 * Two safety properties beyond the basic dedupe:
 *  - `lastCommitted` only advances after the commit callback actually
 *    succeeds. A thrown error, a rejected promise, or an explicit `false`
 *    leaves the value eligible for retry (e.g. the user fixes a validation
 *    problem and blurs again with the same text).
 *  - Enter commits and then blurs the field, which would otherwise fire the
 *    blur listener again for a commit that is still in flight. Rather than
 *    branching on which event fired, an in-flight commit for a given value
 *    is tracked and reused, so Enter+blur for the same value coalesces into
 *    exactly one call to the commit callback.
 */
export function bindCommitOnBlurOrEnter(input: CommitInputLike, initialValue: string, commit: (value: string) => CommitResult): { commitNow(): Promise<void> } {
  let lastCommitted = initialValue;
  let pending: { value: string; promise: Promise<void> } | null = null;

  const runCommit = async (value: string): Promise<void> => {
    try {
      const result = await commit(value);
      if (result !== false) {
        lastCommitted = value;
      }
    } catch {
      // The commit callback owns surfacing failure (e.g. a Notice); this
      // binder only needs to know not to advance lastCommitted so the same
      // value can be retried on the next blur/Enter.
    }
  };

  const commitNow = (): Promise<void> => {
    const value = input.value;
    if (value === lastCommitted) {
      return Promise.resolve();
    }
    if (pending && pending.value === value) {
      return pending.promise;
    }
    const promise = runCommit(value).finally(() => {
      if (pending?.value === value) {
        pending = null;
      }
    });
    pending = { value, promise };
    return promise;
  };

  input.addEventListener("blur", () => { void commitNow(); });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault?.();
    void commitNow();
    input.blur?.();
  });

  return { commitNow };
}
