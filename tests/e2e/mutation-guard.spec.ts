import { expect, test } from "@playwright/test";

test("guards same-origin mutations with Host/Origin checks and CSRF fallback", async ({
  request,
  baseURL,
}) => {
  const origin = baseURL;
  if (!origin) throw new Error("Missing Playwright baseURL.");

  const csrf = await request.get("/api/csrf");
  expect(csrf.status()).toBe(200);
  expect(csrf.headers()["access-control-allow-origin"]).toBeUndefined();
  const { token } = (await csrf.json()) as { token: string };
  expect(typeof token).toBe("string");
  expect(token.length).toBeGreaterThan(20);

  const sameOrigin = await request.post("/api/lab/mutation-probe", {
    headers: { origin },
    data: { message: "hello" },
  });
  expect(sameOrigin.status()).toBe(200);
  expect(await sameOrigin.json()).toEqual({
    ok: true,
    received: { message: "hello" },
  });

  const crossOrigin = await request.post("/api/lab/mutation-probe", {
    headers: { origin: "http://evil.example:3000" },
    data: { message: "hello" },
  });
  expect(crossOrigin.status()).toBe(403);
  expect(
    ((await crossOrigin.json()) as { error: { code: string } }).error.code,
  ).toBe("forbidden-origin");
  expect(crossOrigin.headers()["access-control-allow-origin"]).toBeUndefined();

  const noOriginNoToken = await request.post("/api/lab/mutation-probe", {
    data: { message: "hello" },
  });
  expect(noOriginNoToken.status()).toBe(403);
  expect(
    ((await noOriginNoToken.json()) as { error: { code: string } }).error.code,
  ).toBe("missing-csrf-token");

  const tokenOnly = await request.post("/api/lab/mutation-probe", {
    headers: { "x-lab-csrf-token": token },
    data: { message: "token" },
  });
  expect(tokenOnly.status()).toBe(200);

  const malformed = await request.post("/api/lab/mutation-probe", {
    headers: { origin, "content-type": "application/json" },
    data: Buffer.from("{not json", "utf8"),
  });
  expect(malformed.status()).toBe(400);

  const wrongType = await request.post("/api/lab/mutation-probe", {
    headers: { origin, "content-type": "text/plain" },
    data: "{}",
  });
  expect(wrongType.status()).toBe(415);

  const oversized = await request.post("/api/lab/mutation-probe", {
    headers: { origin, "content-type": "application/json" },
    data: JSON.stringify({ message: "x".repeat(70 * 1024) }),
  });
  expect(oversized.status()).toBe(413);

  const invalidBody = await request.post("/api/lab/mutation-probe", {
    headers: { origin },
    data: { message: "" },
  });
  expect(invalidBody.status()).toBe(422);

  const crossOriginToken = await request.get("/api/csrf", {
    headers: { origin: "http://evil.example:3000" },
  });
  expect(crossOriginToken.status()).toBe(403);

  // Next.js itself rejects GET on a POST-only route; the guard's own 405
  // contract is covered by the unit tests.
  const readOnly = await request.get("/api/lab/mutation-probe");
  expect(readOnly.status()).toBe(405);
});
