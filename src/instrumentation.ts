export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE?.includes("build")) return;

  const { startServerLock } = await import("./server/startup");
  await startServerLock();
}
