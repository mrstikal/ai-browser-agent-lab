import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { BrowserUse } from "@browser_use/pi";
import { nodeVersionProblem } from "./node-version.mjs";
import { assertDisplay, withLaunchGuidance } from "./browser-launch";

const HEADING = "AI Browser Agent Lab - local browser smoke";
const PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Local smoke</title></head>
  <body><main><h1>${HEADING}</h1><p>No inference, no key, no cloud browser.</p></main></body>
</html>
`;

const allowedDomains = ["127.0.0.1", "localhost"];
const prohibitedDomains: string[] = [];

async function installedSdkVersion(): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.resolve("@browser_use/pi")));
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === "@browser_use/pi" && typeof manifest.version === "string") {
        return manifest.version;
      }
    } catch {
      // The resolved entry may sit below the package root; keep walking up.
    }
    directory = dirname(directory);
  }
  throw new Error("Could not locate installed @browser_use/pi package metadata.");
}

const headless = process.argv.includes("--headless") || process.env.SMOKE_HEADLESS === "1";

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startLocalSite(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const handler = (_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(PAGE);
  };

  const ipv4 = createServer(handler);
  await listen(ipv4, "127.0.0.1", 0);
  const port = (ipv4.address() as AddressInfo).port;

  const ipv6 = createServer(handler);
  let ipv6Bound = false;
  try {
    await listen(ipv6, "::1", port);
    ipv6Bound = true;
  } catch {
    await closeServer(ipv6);
  }

  return {
    port,
    close: async () => {
      await Promise.all([closeServer(ipv4), ipv6Bound ? closeServer(ipv6) : Promise.resolve()]);
    },
  };
}

type Reading = { url: string; heading: string | null; title: string };

function parseCellJson(text: string): Reading {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Partial<Reading>;
      if (
        typeof parsed.url === "string" &&
        (parsed.heading === null || typeof parsed.heading === "string") &&
        typeof parsed.title === "string"
      ) {
        return { url: parsed.url, heading: parsed.heading, title: parsed.title };
      }
    } catch {
      // Keep looking for the JSON line printed by the cell.
    }
  }
  throw new Error(`The browser cell did not return a JSON reading. Output was:\n${text}`);
}

async function readHeading(agent: BrowserUse, url: string): Promise<Reading> {
  const code = [
    `const target = ${JSON.stringify(url)};`,
    "const info = await page.goto(target);",
    "const heading = await page.evaluate(() => document.querySelector('h1')?.textContent?.trim() ?? null);",
    "console.log(JSON.stringify({ url: info.url, title: info.title, heading }));",
  ].join("\n");
  const cell = await agent.execute(code, { timeoutMs: 30_000 });
  return parseCellJson(cell.text);
}

async function main(): Promise<void> {
  const nodeProblem = nodeVersionProblem();
  if (nodeProblem) throw new Error(nodeProblem);
  assertDisplay({ headless });
  const sdkVersion = await installedSdkVersion();
  const { Browser, BrowserUse } = await import("@browser_use/pi");
  let site: Awaited<ReturnType<typeof startLocalSite>> | undefined;
  let workspace: string | undefined;
  let agent: BrowserUse | undefined;
  try {
    workspace = await mkdtemp(join(tmpdir(), "ai-browser-lab-smoke-"));
    site = await startLocalSite();
    agent = await BrowserUse.create({
      model: "openrouter/openai/gpt-5.6-luna",
      browser: Browser.chromium({ headless }),
      workspace,
      allowedDomains,
      prohibitedDomains,
      telemetry: false,
      highlightActions: true,
    });

    const targets = [
      `http://127.0.0.1:${site.port}/`,
      `http://localhost:${site.port}/`,
    ];
    const readings: Reading[] = [];
    for (const target of targets) {
      const reading = await readHeading(agent, target);
      if (reading.heading !== HEADING) {
        throw new Error(
          `Expected heading ${JSON.stringify(HEADING)} at ${target}, received ${JSON.stringify(reading.heading)}.`,
        );
      }
      readings.push(reading);
      console.log(
        `Read ${JSON.stringify(reading.heading)} via ${reading.url} (title: ${JSON.stringify(reading.title)}).`,
      );
    }

    let domainPolicy: "blocked" | "not-blocked" = "not-blocked";
    try {
      await agent.execute('await page.goto("http://example.invalid/")', {
        timeoutMs: 5_000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/domain policy|navigation blocked/i.test(message)) {
        domainPolicy = "blocked";
      }
    }
    if (domainPolicy !== "blocked") {
      throw new Error(
        "The SDK did not enforce the configured allowedDomains navigation policy.",
      );
    }

    console.log(
      JSON.stringify(
        {
          sdk: "@browser_use/pi",
          sdkVersion,
          mode: headless ? "headless" : "visible",
          origins: readings.map((reading) => new URL(reading.url).origin),
          allowedDomainsType:
            "string[] | undefined (compile-time checked against installed DomainOptions)",
          domainPolicy,
          inferenceCalls: 0,
          keyRequired: false,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    throw withLaunchGuidance(error, { headless });
  } finally {
    if (agent) {
      await agent.close().catch((error: unknown) => {
        console.error(
          `Warning: failed to close the browser session: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    if (site) {
      await site.close().catch((error: unknown) => {
        console.error(
          `Warning: failed to close the local HTTP server: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    if (workspace) {
      await rm(workspace, { recursive: true, force: true }).catch((error: unknown) => {
        console.error(
          `Warning: failed to remove the temporary workspace: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
