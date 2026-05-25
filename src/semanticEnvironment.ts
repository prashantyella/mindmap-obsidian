import type { ResolvedRuntime } from "./pathResolver";
import { SemanticWorkerClient } from "./semanticWorkerClient";
import type { LiveRelatedResponse, SemanticHealth } from "./semanticTypes";

export interface SemanticEnvironmentStatus {
  state: "off" | "starting" | "ready" | "degraded";
  message: string;
  health: SemanticHealth | null;
}

export class MindmapSemanticEnvironment {
  private client: SemanticWorkerClient | null = null;
  private status: SemanticEnvironmentStatus = {
    state: "off",
    message: "Semantic environment is off.",
    health: null,
  };

  constructor(
    private readonly getRuntime: () => ResolvedRuntime,
    private readonly appendLog: (message: string) => void,
    private readonly updateStatus: () => void,
  ) {}

  getStatus(): SemanticEnvironmentStatus {
    return { ...this.status };
  }

  async start(scope = "current"): Promise<SemanticEnvironmentStatus> {
    const runtime = this.getRuntime();
    if (!runtime.valid) {
      const error = runtime.messages.find((message) => message.level === "error");
      this.setStatus("degraded", error?.message ?? "Runtime is not ready.", null);
      return this.getStatus();
    }

    this.setStatus("starting", "Starting semantic environment.", null);
    this.client = new SemanticWorkerClient({ runtime });
    try {
      const health = await this.client.start(scope);
      this.setStatus("ready", `Semantic environment ready (${health.indexed_notes} notes indexed).`, health);
    } catch (error) {
      this.setStatus("degraded", toErrorMessage(error), null);
    }
    return this.getStatus();
  }

  async queryRelated(path: string, ensureIndex: boolean): Promise<LiveRelatedResponse> {
    if (this.status.state !== "ready" || this.client === null) {
      await this.start("current");
    }
    if (this.client === null || this.status.state !== "ready") {
      throw new Error(this.status.message);
    }
    return this.client.queryRelated(path, ensureIndex);
  }

  async shutdown(): Promise<void> {
    await this.client?.shutdown();
    this.client = null;
    this.setStatus("off", "Semantic environment is off.", null);
  }

  private setStatus(state: SemanticEnvironmentStatus["state"], message: string, health: SemanticHealth | null): void {
    this.status = { state, message, health };
    this.appendLog(`[semantic] ${message}`);
    this.updateStatus();
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
