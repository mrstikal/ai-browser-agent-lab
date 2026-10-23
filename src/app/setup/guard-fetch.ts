export async function guardedJsonFetch(
  url: string,
  init: { readonly method: "POST" | "DELETE"; readonly body?: unknown },
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };

  try {
    const csrf = await fetch("/api/csrf", {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (csrf.ok) {
      const payload = (await csrf.json()) as { token?: unknown };
      if (typeof payload.token === "string" && payload.token.length > 0) {
        headers["x-lab-csrf-token"] = payload.token;
      }
    }
  } catch {
    // Origin still protects the request; the token is only a fallback.
  }

  return fetch(url, {
    method: init.method,
    headers,
    body: JSON.stringify(init.body ?? {}),
    credentials: "same-origin",
    cache: "no-store",
  });
}

export async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as {
      error?: { code?: unknown; message?: unknown };
    };
    const message = payload.error?.message;
    if (typeof message === "string" && message.length > 0) return message;
  } catch {
    // Fall through to a generic message.
  }
  return `The request failed (${response.status}).`;
}
