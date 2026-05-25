import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ResolvedRuntime } from "./pathResolver";
import type {
  DeletePathsResponse,
  IndexPathsResponse,
  LiveRelatedResponse,
  SemanticHealth,
  SemanticWorkerFailure,
  SemanticWorkerMethod,
  SemanticWorkerResponse,
} from "./semanticTypes";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface SemanticWorkerClientOptions {
  runtime: ResolvedRuntime;
  requestTimeoutMs?: number;
}

export class SemanticWorkerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private pending = new Map<string, PendingRequest>();
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: SemanticWorkerClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  async start(scope = "default"): Promise<SemanticHealth> {
    if (!this.options.runtime.valid) {
      const error = this.options.runtime.messages.find((message) => message.level === "error");
      throw new Error(error?.message ?? "Mindmap runtime is not valid.");
    }
    if (!this.running) {
      this.spawnWorker();
    }
    return this.initialize(scope);
  }

  initialize(scope = "default"): Promise<SemanticHealth> {
    return this.request<SemanticHealth>("initialize", {
      config: this.options.runtime.configPath,
      scope,
    });
  }

  health(): Promise<SemanticHealth> {
    return this.request<SemanticHealth>("health", {});
  }

  queryRelated(pathValue: string, ensureIndex: boolean): Promise<LiveRelatedResponse> {
    return this.request<LiveRelatedResponse>("query_related", {
      path: pathValue,
      ensure_index: ensureIndex,
    });
  }

  indexPaths(paths: string[]): Promise<IndexPathsResponse> {
    return this.request<IndexPathsResponse>("index_paths", { paths });
  }

  deletePaths(paths: string[]): Promise<DeletePathsResponse> {
    return this.request<DeletePathsResponse>("delete_paths", { paths });
  }

  async shutdown(): Promise<void> {
    if (!this.child) {
      return;
    }
    try {
      await this.request("shutdown", {});
    } finally {
      this.child?.kill();
      this.child = null;
      this.rejectAll(new Error("Mindmap semantic worker shut down."));
    }
  }

  private spawnWorker(): void {
    const workerPath = path.join(path.dirname(this.options.runtime.scriptPath), "mindmap_worker.py");
    this.child = spawn(this.options.runtime.command.command, [workerPath], {
      cwd: this.options.runtime.command.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-8000);
    });
    this.child.on("exit", (code, signal) => {
      this.rejectAll(new Error(`Mindmap semantic worker exited (${code ?? signal ?? "unknown"}). ${this.stderrBuffer}`.trim()));
      this.child = null;
    });
    this.child.on("error", (error) => {
      this.rejectAll(error);
      this.child = null;
    });
  }

  private request<TResult>(method: SemanticWorkerMethod, params: Record<string, unknown>): Promise<TResult> {
    if (!this.running) {
      this.spawnWorker();
    }
    const child = this.child;
    if (!child) {
      return Promise.reject(new Error("Mindmap semantic worker is not available."));
    }

    const id = String(this.nextRequestId++);
    const payload = JSON.stringify({ id, method, params }) + "\n";
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Mindmap semantic worker request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      child.stdin.write(payload, "utf8", (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleMessage(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleMessage(line: string): void {
    let message: SemanticWorkerResponse;
    try {
      message = JSON.parse(line) as SemanticWorkerResponse;
    } catch {
      return;
    }
    if (!("id" in message) || message.id === null) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error((message as SemanticWorkerFailure).error));
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
