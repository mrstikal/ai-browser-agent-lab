import type { AppConfig } from "../src/server/config";

export type NextMode = "dev" | "build" | "start";

export function buildNextArgs(mode: NextMode, config: AppConfig): string[] {
  if (mode === "build") return [mode];
  return [mode, "--hostname", config.bindHost, "--port", String(config.port)];
}

export function nextLaunchTarget(mode: NextMode, config: AppConfig): string {
  if (mode === "build") return "";
  return ` on ${config.origin} (bind ${config.bindHost}:${config.port})`;
}
