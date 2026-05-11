import fs from "node:fs";
import path from "node:path";

export type BotRuntimeState = "running" | "paused" | "reduce_only" | "emergency_stop";

export type BotControlOverride = {
  state: BotRuntimeState;
  reason?: string;
  cancelOpenOrders?: boolean;
  updatedAt?: string;
};

type ControlFileShape = {
  version: 1;
  updatedAt: string;
  bots?: Record<string, BotControlOverride>;
  systemLiquidity?: BotControlOverride | null;
};

export class BotControlFileStore {
  private readonly filePath: string;
  private lastReadAt = 0;
  private cached: ControlFileShape | null = null;

  constructor(filePath?: string) {
    this.filePath =
      filePath ??
      process.env.POLY_BOT_CONTROL_FILE ??
      path.resolve(process.cwd(), "runtime", "bot-controls.json");
  }

  getPath() {
    return this.filePath;
  }

  read(systemLiquidity: boolean, botName: string): BotControlOverride | null {
    const now = Date.now();
    if (!this.cached || now - this.lastReadAt > 1_000) {
      this.cached = this.load();
      this.lastReadAt = now;
    }
    const globalOverride = systemLiquidity ? this.cached?.systemLiquidity ?? null : null;
    const botOverride = this.cached?.bots?.[botName] ?? null;
    return botOverride ?? globalOverride;
  }

  write(update: {
    botName?: string;
    systemLiquidity?: boolean;
    state: BotRuntimeState;
    reason?: string;
    cancelOpenOrders?: boolean;
  }) {
    const existing = this.load();
    const next: ControlFileShape = {
      version: 1,
      updatedAt: new Date().toISOString(),
      bots: { ...(existing?.bots ?? {}) },
      systemLiquidity: existing?.systemLiquidity ?? null,
    };
    const value: BotControlOverride = {
      state: update.state,
      ...(update.reason ? { reason: update.reason } : {}),
      ...(update.cancelOpenOrders !== undefined ? { cancelOpenOrders: update.cancelOpenOrders } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (update.systemLiquidity) {
      next.systemLiquidity = value;
    }
    if (update.botName) {
      next.bots![update.botName] = value;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    this.cached = next;
    this.lastReadAt = Date.now();
  }

  clear(update: { botName?: string; systemLiquidity?: boolean }) {
    const existing = this.load();
    const next: ControlFileShape = {
      version: 1,
      updatedAt: new Date().toISOString(),
      bots: { ...(existing?.bots ?? {}) },
      systemLiquidity: existing?.systemLiquidity ?? null,
    };
    if (update.systemLiquidity) {
      next.systemLiquidity = null;
    }
    if (update.botName && next.bots) {
      delete next.bots[update.botName];
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    this.cached = next;
    this.lastReadAt = Date.now();
  }

  private load(): ControlFileShape | null {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as ControlFileShape;
      if (!parsed || parsed.version !== 1) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
}
