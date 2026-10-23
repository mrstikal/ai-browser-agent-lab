import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const playwrightBin = join(projectRoot, "node_modules", ".bin", "playwright");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not determine a free loopback port.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

const port = await freePort();
console.log(`[ai-browser-agent-lab] Playwright base URL: http://127.0.0.1:${port}`);

const child = spawn(playwrightBin, ["test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, E2E_PORT: String(port) },
});

const forwardSigint = () => child.kill("SIGINT");
const forwardSigterm = () => child.kill("SIGTERM");
process.on("SIGINT", forwardSigint);
process.on("SIGTERM", forwardSigterm);

child.on("error", (error) => {
  console.error(`[ai-browser-agent-lab] Failed to start Playwright: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.off("SIGINT", forwardSigint);
  process.off("SIGTERM", forwardSigterm);
  if (signal === "SIGINT") process.exit(130);
  if (signal === "SIGTERM") process.exit(143);
  process.exit(code ?? 1);
});
