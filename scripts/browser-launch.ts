export interface DisplayCheck {
  readonly headless: boolean;
  readonly platform?: string | undefined;
  readonly display?: string | undefined;
  readonly waylandDisplay?: string | undefined;
}

export function displayProblem(options: DisplayCheck): string | null {
  if (options.headless) return null;
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return null;
  if (options.display || options.waylandDisplay) return null;
  return [
    "No graphical display was detected (DISPLAY and WAYLAND_DISPLAY are unset).",
    "Visible Chromium needs a desktop session, WSLg, or an X server.",
    "On WSL, enable WSLg (Windows 11) or start an X server and export DISPLAY.",
    "For a headless feasibility check only, pass --headless or set SMOKE_HEADLESS=1.",
  ].join("\n");
}

export function assertDisplay(options: DisplayCheck = { headless: false }): void {
  const problem = displayProblem({
    ...options,
    display: options.display ?? process.env.DISPLAY,
    waylandDisplay: options.waylandDisplay ?? process.env.WAYLAND_DISPLAY,
  });
  if (problem) throw new Error(problem);
}

export function isLaunchFailure(message: string): boolean {
  return /Chrome not found|Chrome exited|did not expose CDP|display|DISPLAY|X server|WSLg/i.test(
    message,
  );
}

export function withLaunchGuidance(
  error: unknown,
  options: { readonly headless: boolean },
): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (!isLaunchFailure(message)) {
    return error instanceof Error ? error : new Error(message);
  }
  const hints = [
    "Install Google Chrome or Chromium (for example: sudo apt install chromium),",
    "or set an explicit browser path when using the SDK in application code.",
    "A visible run also requires a working display; WSLg is recommended on WSL.",
    options.headless
      ? "The run was already headless; check that Chrome can start at all in this environment."
      : "For a headless attempt, rerun with --headless.",
  ];
  return new Error([message, "", ...hints].join("\n"));
}
