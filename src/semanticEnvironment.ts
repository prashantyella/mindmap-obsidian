import type { ResolvedRuntime } from "./pathResolver";
import { SemanticWorkerClient, type SemanticWorkerClientOptions } from "./semanticWorkerClient";
import type { LiveRelatedResponse, LookupRelatedResponse, SemanticHealth } from "./semanticTypes";

export interface SemanticEnvironmentStatus {
  state: "off" | "starting" | "ready" | "degraded";
  message: string;
  health: SemanticHealth | null;
}

interface SemanticClient {
  start(scope?: string): Promise<SemanticHealth>;
  queryRelated(path: string, ensureIndex: boolean): Promise<LiveRelatedResponse>;
  queryText(query: string, limit?: number): Promise<LookupRelatedResponse>;
  shutdown(): Promise<void>;
}

type SemanticClientFactory = (options: SemanticWorkerClientOptions) => SemanticClient;

export class MindmapSemanticEnvironment {
  private client: SemanticClient | null = null;
  private startPromise: Promise<SemanticEnvironmentStatus> | null = null;
  private status: SemanticEnvironmentStatus = {
    state: "off",
    message: "Semantic environment is off.",
    health: null,
  };

  constructor(
    private readonly getRuntime: () => ResolvedRuntime,
    private readonly appendLog: (message: string) => void,
    private readonly updateStatus: () => void,
    private readonly createClient: SemanticClientFactory = (options) => new SemanticWorkerClient(options),
  ) {}

  getStatus(): SemanticEnvironmentStatus {
    return { ...this.status };
  }

  async start(scope = "current"): Promise<SemanticEnvironmentStatus> {
    if (this.startPromise !== null) {
      return this.startPromise;
    }
    this.startPromise = this.startOnce(scope).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async queryRelated(path: string, ensureIndex: boolean): Promise<LiveRelatedResponse> {
    await this.ensureReady();
    try {
      return await this.requireClient().queryRelated(path, ensureIndex);
    } catch (error) {
      this.setStatus("degraded", toErrorMessage(error), null);
      await this.restart("current");
      return this.requireClient().queryRelated(path, ensureIndex);
    }
  }

  async queryText(query: string, limit?: number): Promise<LookupRelatedResponse> {
    await this.ensureReady();
    try {
      return await this.requireClient().queryText(query, limit);
    } catch (error) {
      this.setStatus("degraded", toErrorMessage(error), null);
      await this.restart("current");
      return this.requireClient().queryText(query, limit);
    }
  }

  async shutdown(): Promise<void> {
    await this.client?.shutdown();
    this.client = null;
    this.setStatus("off", "Semantic environment is off.", null);
  }

  private async startOnce(scope: string): Promise<SemanticEnvironmentStatus> {
    const runtime = this.getRuntime();
    if (!runtime.valid) {
      const error = runtime.messages.find((message) => message.level === "error");
      this.setStatus("degraded", error?.message ?? "Runtime is not ready.", null);
      return this.getStatus();
    }

    this.setStatus("starting", "Starting semantic environment.", null);
    await this.client?.shutdown().catch((error: unknown) => {
      this.appendLog(`[semantic] Previous worker shutdown failed: ${toErrorMessage(error)}`);
    });
    this.client = this.createClient({
      runtime,
      onExit: (error) => {
        if (this.status.state !== "off") {
          this.client = null;
          this.setStatus("degraded", toErrorMessage(error), null);
        }
      },
    });
    try {
      const health = await this.client.start(scope);
      this.setStatus("ready", `Semantic environment ready (${health.indexed_notes} notes indexed).`, health);
    } catch (error) {
      this.setStatus("degraded", toErrorMessage(error), null);
    }
    return this.getStatus();
  }

  private async ensureReady(): Promise<void> {
    if (this.status.state !== "ready" || this.client === null) {
      await this.start("current");
    }
    if (this.client === null || this.status.state !== "ready") {
      throw new Error(this.status.message);
    }
  }

  private async restart(scope: string): Promise<void> {
    await this.client?.shutdown().catch((error: unknown) => {
      this.appendLog(`[semantic] Worker shutdown before restart failed: ${toErrorMessage(error)}`);
    });
    this.client = null;
    await this.start(scope);
    if (this.client === null || this.status.state !== "ready") {
      throw new Error(this.status.message);
    }
  }

  private requireClient(): SemanticClient {
    if (this.client === null) {
      throw new Error(this.status.message);
    }
    return this.client;
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
