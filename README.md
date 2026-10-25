# AI Browser Agent Lab

A standalone, single-user, local proof of concept. It combines:

- a fixed 24-product storefront with deterministic catalog rules;
- AI-generated product images from OpenRouter;
- two local test forms with persisted submissions;
- a real local Chromium agent driven by `@browser_use/pi`;
- deterministic, server-side evaluation of five preset browser tasks;
- persisted run history, traces, and honest execution/usage labels;
- optional Classic and Alternate layouts that rearrange the same catalog and form content.

There is no checkout, payment, authentication, multi-user support, cloud browser, or
external database. The application binds to a loopback origin only and stores its state
under the Git-ignored `data/` directory.

## Status and acceptance

The deterministic implementation and local test suites are complete. Paid live
acceptance is deliberately separate:

- The deterministic image flow generates all 24 images against a loopback OpenRouter
  mock, and the built `start` path is exercised with a fake agent SDK. Neither makes a
  provider request.
- The real 24-image provider flow and real local-browser task(s) through the app,
  including built `start`, require separate authorization and observation. In this
  checkout those live checks are **`Partial - Unverified`**, not core completion.
- Browser-model vision support is **`Unverified`** unless a tool result actually carried
  image content. A correct text answer from the page heading does not prove that
  screenshots reached the model.
- A completed agent process is not a passed business task. The dashboard shows
  execution status, the independent evaluation, and UI evidence separately.
- Classic and Alternate layouts are available on the catalog, forms, and agent pages.
  They change only arrangement; data, routes, labels, and task instructions stay the
  same. Each new agent run records the mode at its start.

The development checkout has a recorded authorized heading observation for the tuple
`openrouter/openai/gpt-5.6-luna`, `@browser_use/pi` `0.1.0`, and
`http://127.0.0.1:3000` (2026-10-24), with vision unverified. The stamp is stored per data
directory in `data/agent-compatibility.json`; a fresh clone starts unverified and must run
its own browser verification.

## Requirements

### Node.js

- Node.js **22.19 or newer** is required. The tested default is `22.22.2` (`.nvmrc`).
- `package.json` declares `engines.node >= 22.19`, `.npmrc` enables `engine-strict`, and
  every application command runs `scripts/check-node.mjs` before startup.
- With nvm:

  ```bash
  nvm install
  nvm use
  node -v
  ```

  `npm run check:runtime` checks the version without starting the app.

### Browser and display

- Install Google Chrome or Chromium. Browser Use Pi does not bundle a browser. Common
  Linux paths include `/usr/bin/google-chrome`, `/usr/bin/chromium`, and
  `/usr/bin/chromium-browser`.
- The agent demo uses a **visible** browser. On Linux or WSL you need a graphical session,
  WSLg (recommended on Windows 11), or an X server with `DISPLAY` set. The standalone
  `smoke:browser-local` and `test:agent` scripts add installation/display guidance when
  Chrome cannot launch. The application's `/agent` path reports the bounded worker launch
  error; use the troubleshooting table below if the browser or display is unavailable.
- The browser smoke and agent smoke accept `--headless` / `SMOKE_HEADLESS=1`. For
  `smoke:browser-local`, headless is a local no-charge feasibility option. `test:agent` is
  still billable whenever `--live --approve-paid` is supplied, even in headless mode;
  headless only skips the display preflight. Headless is not the documented interactive
  demo.
- Playwright E2E uses the installed system Chrome by default (`PLAYWRIGHT_CHANNEL=chrome`).
  No separate Playwright browser download is required for this repository's default test
  command.

### Network and runtime

- The app listens on `http://127.0.0.1:3000` by default. Do not expose it on a LAN
  interface; it has no authentication.
- Normal application traffic leaves the machine only for explicitly approved OpenRouter
  requests. Next.js telemetry is disabled.
- npm with the committed lockfile is the supported package manager.

## Quick start from a fresh clone

```bash
git clone <repository-url> ai-browser-agent-lab
cd ai-browser-agent-lab
nvm install
nvm use
npm ci
npm run dev
```

Open <http://127.0.0.1:3000>. No API key, `data/` directory, or provider account is needed
to start the server. The catalog and forms remain browseable with image placeholders. A
fresh visitor is redirected from `/` to `/setup`.

The first server start creates the private `data/` tree and `data/.server.lock`. Confirm
the local server is healthy:

```bash
curl http://127.0.0.1:3000/api/health
# {"ok":true,"app":"ai-browser-agent-lab"}
```

Stop the server with `Ctrl+C` and wait for the wrapper to exit.

### Built server

```bash
npm run build
npm run start
```

Built `start` uses the same origin, storage, worker, and recovery behavior as `dev`. Build
first; `npm run start` does not build for you. The deterministic built-path check is:

```bash
npm run smoke:built-worker
```

It requires a production build, starts `npm run start`, runs one fake-SDK worker, checks
cleanup and key handling, and makes no provider request. It is POSIX-only (Linux/WSL).

### A different loopback port

```bash
APP_ORIGIN=http://127.0.0.1:3100 npm run dev
```

`APP_ORIGIN` must be an origin only: `http`, a loopback host (`127.0.0.1`, `localhost`, or
`[::1]`), and an explicit port, with no path, query, credentials, or fragment. The same
value drives the Next bind address, the Host/Origin mutation guard, and the agent's start
URL. Use one origin consistently for the browser tab, agent runs, and tests.

## First-run setup and image generation

1. Open `/setup`.
2. Enter an OpenRouter API key. It is validated with a non-billable
   `GET https://openrouter.ai/api/v1/key` request.
   - **Remember API Key is off by default.** The key stays only in the local server
     process. Refreshes reuse it, but a server restart requires re-entry.
   - With Remember on, the key is stored as **plaintext** at
     `data/secrets/openrouter-key` with mode `0600` where the filesystem supports it.
     This is not encryption. WSL, network filesystems, and other mounts may not enforce
     equivalent permissions.
   - A management-only key can validate but cannot run inference or image generation.
   - Key replacement or deletion invalidates the browser-model compatibility stamp before
     the change. Both are refused while a paid operation is active.
3. Choose the image model and browser model. The defaults are
   `black-forest-labs/flux-3-image-klein` for images and
   `openrouter/openai/gpt-5.6-luna` for the browser agent. Image-model capabilities and
   pricing are checked against live metadata during quoting. Browser model IDs are
   format-checked when saved; actual account/model access is established only by the paid
   browser verification run. A public catalog entry is not proof of account access.
4. Review the current quote. It shows the target IDs, unit price, base estimate, the
   worst case with up to two retries per image, and the indicative starting balance needed
   to keep $1 available before **each** image request.
5. Check the confirmation box and start the batch. Only missing images are targeted unless
   you explicitly choose a regeneration/resume path.
6. Watch progress on `/setup` over SSE, with a GET fallback if the stream is interrupted.
   Each of the 24 successful IDs is counted once. Generated images are validated and
   persisted; a refresh or restart does not regenerate valid images.

### Costs

**All OpenRouter usage is charged to your OpenRouter account.** The application cannot
provide a provider invoice or a hard account-side spending cap.

- The image quote is computed from the selected model's live endpoint metadata and an
  exact fixed-point USD price. Unknown or stale pricing blocks generation instead of
  showing `$0`.
- Example only, from the 2026-10-23 metadata used during development:
  `flux-3-image-klein` at 768 px and `1:1` was $0.008 per image. For 24 images that is
  $0.192 for one attempt per image, $0.576 for the three-attempt worst case, and an
  indicative starting balance of $1.184 (base) or $1.568 (worst case) because the image
  API requires $1 available before each request. Recheck the displayed quote; it is
  authoritative for your run.
- The image API can return HTTP 402 when the available balance is below $1 before a
  request, even if the projected batch costs less. Stop on 402 and add credit or choose a
  verifiably priced model.
- Agent verification uses fixed limits of 8 steps, 120 seconds, and a $0.25 soft cost
  limit. Task runs default to 30 steps, 180 seconds, and a $1.00 soft cost limit; the
  server accepts up to 200 steps, 30 minutes, and $100. The SDK checks the soft cost limit
  between turns and may overshoot by one response. Usage is an SDK-side estimate, not a
  provider invoice.
- A network timeout can still incur provider charges even when no image is returned. A
  failed or interrupted attempt is recorded with reported, estimated, or unknown cost; it
  is never silently treated as free.
- Use a dedicated OpenRouter key with an account-side spending limit, and rotate it if it
  is exposed. Local soft limits do not replace provider-side limits.

### Stop and resume

- **Stop batch** on `/setup` persists a stop request for the current job ID. It does not
  abort a request already in flight. The UI shows `stopping` until that request settles,
  then `stopped_by_user` and releases the paid-operation lock.
- No next request or retry is sent after a stop is observed. A late or duplicate stop is
  idempotent.
- Continuing requires a **new quote and a new explicit confirmation**. The app never
  auto-resumes a paid request after a restart.
- After a failed, interrupted, or stopped batch, `/setup` offers **Resume missing images**
  or **Retry failed images** where applicable. Valid images are reused; only the displayed
  targets are quoted and requested.
- A completed batch requires every target to succeed or be deliberately reused and all 24
  active files to validate. A failed regeneration can leave 24 older valid images while
  its job remains failed.

### Restart recovery

On startup the server performs local-only recovery before serving:

- Agent recovery runs first and verifies recorded worker process groups.
- Image recovery reconciles an unpublished image only when its product/attempt ID matches
  a manifest attempt still marked `started`, its timestamp is not before the attempt
  start, and its bytes validate. That already-paid result is recovered without a provider
  request.
- Unmatched files are moved to `data/images/orphans/` and reported, not silently deleted
  or published.
- An active job from a dead server is marked `interrupted`; its stop request is preserved.
- Recovery reports are written to `data/image-recovery.json` and
  `data/agent-recovery.json`.

## Storefront and forms

- `/shop` renders exactly 24 fixed products, six per unfiltered page, with four pages.
  Search, category, in-stock, and price sort are URL-based GET controls. Filters and
  sorting apply before pagination.
- Product attributes are fixed in source code. AI generates images only.
- Product detail pages use exact slugs, return real 404s for unknown slugs, and preselect
  the product on the inquiry form.
- `/forms/support` requires full name, valid email, subject, priority, description, and a
  checked local-test confirmation. It shows a review step before submission.
- `/forms/inquiry` requires full name, valid email, a known product ID, inquiry type, and
  message. Product detail pages preselect the product.
- Both forms validate on the server with Zod, persist one UUID record under
  `data/submissions/`, and show the confirmation ID. There is no email or payment
  integration.
- `/submissions` lists both form types. **Reset submissions** removes only support and
  inquiry records; it never removes images, keys, settings, or agent history. It is
  refused during an active agent run or another paid operation.

### Classic and Alternate layouts

The layout switcher is available on `/shop`, both form pages, and `/agent`. It is one
global local setting, so the agent's browser sees the same arrangement as your browser.

- **Classic**: catalog filters above a three-column card grid, and single-column form
  fields.
- **Alternate**: catalog filters in a sidebar beside a two-column card grid, and
  two-column form fields with the long text area spanning both columns.

Both modes render the same products, labels, field names, values, validation, URLs, and
task instructions. The DOM order stays the same; only the visual arrangement changes. The
setting is stored in `data/ui-settings.json` (mode and timestamp only) and defaults to
Classic. It is not a query parameter or cookie, so it cannot silently change a catalog or
form URL.

The mode is captured from this setting at the start of each new agent run. A saved run
keeps its original mode after you switch layouts. Changing the layout briefly reserves the
same exclusive paid-operation slot: it is refused while an image batch or agent run is
active, and a run start is refused while a layout change is in flight. The mode captured at
start therefore stays stable for the whole run.

## Browser agent

### Verify the browser model first

The agent uses the same server-side key as setup. **Remember can stay off**: as long as
the server process still holds the key, browser verification and agent runs can use it.
After a server restart, re-enter the key on `/setup`.

1. Start the app at the configured origin and open `/agent`.
2. Read the gate. Live tasks stay unavailable until the current key, browser model,
   installed SDK version, and app origin are verified.
3. In **Verify agent model**, review the separate cost warning and check the confirmation
   box. The fixed job visits the local `/shop` page, reads its `h1`, and must return
   `{"heading":"Shop"}` within 8 steps, 120 seconds, and the $0.25 soft cost limit.
4. A passing run writes `data/agent-compatibility.json` only if the pre-run key, model,
   SDK version, and origin still match. The record contains no key.
5. Any key replacement/deletion or browser-model change invalidates the stamp. Re-verify
   after such a change. A stamp belongs to one data directory and does not transfer to a
   fresh clone.

The verification proves browser and model access for a DOM/text task. It does **not**
prove screenshot/vision transport. The dashboard keeps vision `Unverified` until a tool
result actually carries image content; it does not infer vision from token counts or a
correct answer.

### Run tasks and read results

`/agent` supports five presets and a bounded custom task. The presets are:

1. Cheapest available Home product.
2. All out-of-stock products and their count.
3. In-stock Audio products below $70 in ascending price order.
4. Support form submission with prescribed test values.
5. Product inquiry submission with prescribed test values.

Catalog expected values are checked on the server and are not sent to the model. Form
presets necessarily include their prescribed values in the instruction. Before a form
task, the server snapshots existing submission IDs so exactly one new record can be
required.

The dashboard keeps these concepts separate:

- **Execution status**: running, completed, limit reached, error, timed out, cancelled,
  interrupted, or hung.
- **Business evaluation**: passed, failed, or not evaluated. Custom and verification runs
  are never automatically passed.
- **UI evidence**: observed only when a persisted successful browser JavaScript tool event
  exists. This is trace evidence, not cryptographic proof.

A **full task pass** requires completed execution, a passed business evaluation, and
observed UI evidence. A completed process alone is not a pass.

### Cancellation, process cleanup, and manual recovery

- **Cancel** asks the worker to stop cooperatively. The supervisor waits a short grace
  period, then terminates only the verified worker process group. A run stays unavailable
  for a new start until cleanup is proven.
- If the app exits while a run is active, the next startup marks the run `interrupted`,
  verifies and terminates its recorded process group, and removes the disposable browser
  profile only when the group is gone.
- If ownership or group cleanup cannot be proven, the app **fails closed**: it keeps a
  persistent barrier on the shared paid-operation lock and records manual cleanup
  instructions. Inspect `data/agent-recovery.json`, `data/locks/paid-job.lock`, and
  `data/browser-profiles/<runId>/`. A recorded browser process can be inspected with
  `ps -eo pid,pgid,args | grep browser-profiles`. Do not delete the lock merely because
  the app is stopped; confirm the processes are gone first, then restart so recovery can
  clear the barrier.
- The server also holds `data/.server.lock`. A second server on the same `DATA_DIR` exits
  with a clear error. `/api/health` returns 503 if the running server cannot prove it still
  owns that lock.

## Data layout, privacy, and security

`data/` is Git-ignored and local. It is created lazily with private permissions where the
filesystem supports them:

```text
data/
  .server.lock
  settings.json                    # model choices; never the key
  ui-settings.json                 # Classic/Alternate layout; no personal data
  agent-compatibility.json         # verified model/SDK/origin tuple; never the key
  secrets/openrouter-key           # only with Remember on; plaintext, mode 0600
  images/manifest.json             # lifetime attempt/active-image ledger
  images/Pnn-<attempt-id>.<ext>
  images/orphans/
  image-job.json                   # current batch snapshot and stop request
  image-recovery.json
  locks/paid-job.lock              # one paid operation at a time
  submissions/support/<uuid>.json
  submissions/inquiry/<uuid>.json
  agent-runs/<uuid>.json
  agent-events/<uuid>.jsonl
  browser-profiles/<run-id>/       # disposable; removed after verified cleanup
  agent-recovery.json
```

Privacy and security facts:

- Form records contain the values you enter, including name and email. They are stored as
  plaintext local JSON and are not encrypted.
- Agent run records and traces can contain bounded task text, page-derived output, action
  names, timestamps, and error text. They are stored locally. Prompts, cookies, headers,
  and key material are not intentionally persisted, but a trace is not a cryptographic
  audit log.
- The key is never returned to the browser, placed in local storage, URLs, settings, run
  events, or logs. It is passed to the agent child through a private environment channel.
- Browser Use Pi executes generated JavaScript without a security sandbox. The child
  process, prompt restrictions, and SDK hostname allowlist reduce risk but are not
  filesystem or network isolation. Use only trusted local pages, tasks, and test data.
- There is no authentication. Keep the server on loopback and do not expose the port to a
  LAN or the internet.
- Generated image prompts are sent to OpenRouter. Form validation and acknowledgments are
  local and are not AI-generated.
- There is no telemetry, CDN, analytics, or external asset loading in normal use. Approved
  OpenRouter requests are the only expected outbound application traffic.

### Replace or delete the API key

Use the **OpenRouter API key** section on `/setup`:

- Enter a new key and validate it. Remember off keeps it in memory only; Remember on
  replaces the disk copy. The old compatibility stamp is invalidated before the change.
- **Delete key** removes the in-memory key and, if present, the disk file. It does not
  delete valid images or form records. Agent tasks then require a key again.
- Key changes are refused while an image batch or agent run is active. Cancel or wait for
  the operation to settle first.
- After replacing a key, run browser verification again before arbitrary live tasks.

### Reset generated images without deleting the remembered key

Stop the server first. Then remove only image state:

```bash
rm -rf data/images
rm -f data/image-job.json data/image-recovery.json
```

Do **not** remove `data/secrets/openrouter-key` unless you also intend to delete the
remembered key. Restart the app; `/setup` will show a fresh quote for all missing images.
The app does not regenerate images automatically. To keep individual valid images, do not
delete the whole `data/images` directory; use the app's regeneration/resume flow instead.

### Delete form test data

Use **Reset submissions** on `/submissions` (explicit confirmation, refused during active
paid work). To remove records manually, stop the server and remove only:

```bash
rm -rf data/submissions/support data/submissions/inquiry
```

This leaves images, keys, settings, and agent history intact.

### Full local reset

A complete reset removes everything, including a remembered key, settings, form data,
generated images, and agent history:

```bash
# Stop the server first.
rm -rf data
```

Start the app again and complete setup. This action cannot be undone and deletes the
plaintext key if Remember was on.

## Testing and deterministic verification

No ordinary test or build command makes a paid provider request.

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run test:e2e:alternate
npm run build
npm run smoke:browser-local
npm run smoke:built-worker
```

- `npm test` runs Vitest without Chromium or a real API key.
- `npm run test:e2e` starts a loopback OpenRouter mock on a free port, uses a fresh
  temporary `DATA_DIR`, runs Playwright against a loopback dev server with system Chrome,
  and removes the mock/temp data afterwards. It covers the full 24-image mock flow, forms,
  catalog, setup/progress, image delivery, agent dashboard/worker, server lock, and
  mutation guard, including the layout toggle.
- `npm run test:e2e:alternate` seeds the disposable test data with Alternate and reruns
  the existing catalog and form Playwright specs. The default suite starts in Classic, so
  the same assertions are proven in both arrangements. The harness options
  `--ui-mode=classic` and `--ui-mode=alternate` are test-only and must not be used
  with real `data/`.
- `npm run smoke:browser-local` launches local Chromium, reads a local heading through both
  `127.0.0.1` and `localhost`, and closes it. It uses no inference and no key. Use
  `npm run smoke:browser-local -- --headless` only for a display-less feasibility check.
- `npm run smoke:built-worker` requires a production build and verifies built `start` plus
  the fake-SDK worker and POSIX process-group cleanup. It makes no provider request.
- `npm run test:agent` is a no-charge health/key/consent preflight by default. A live
  heading observation requires `--live --approve-paid` and per-observation approval
  (`--approve-observation=1` and/or `2`, or an interactive yes). It honors the shared paid
  lock and stamps the app only with the current remembered key and matching tuple. Do not
  run it without explicit spending approval.
- The deterministic suites do not prove live model access, vision support, or a real
  provider task result. Record live observations separately and label them accurately.

### Local origin and test-only seams

These controls exist for reproducible local tests. They are not user-facing setup options.

- `APP_ORIGIN`: loopback origin with an explicit port. Used by normal `dev`/`start` and
  agent tasks.
- `DATA_DIR`: alternate local state directory. Tests always use a disposable temporary
  directory.
- `OPENROUTER_BASE_URL`: accepted only with `LAB_TEST_MODE=1`, a loopback URL with an
  explicit port, no credentials/query/fragment, and a `DATA_DIR` below the OS temp root
  that is outside the project tree. This prevents a remembered production key in
  `<repo>/data` from being routed to a mock, including when the repository itself is under
  a temp root.
- `AGENT_WORKER_TEST_SDK`: accepted only with `LAB_TEST_MODE=1` and `DATA_DIR`; swaps in
  the deterministic fake agent SDK for tests.
- `PLAYWRIGHT_CHANNEL`: Playwright browser channel; defaults to the installed `chrome`.
- `SMOKE_HEADLESS=1` or `--headless`: skip the display preflight for the standalone
  browser/agent smoke. It does not remove the explicit paid approvals required by
  `test:agent`.
- `MOCK_OPENROUTER_*`, `E2E_PORT`, and the mock counters are internal to the E2E harness.

Never point `OPENROUTER_BASE_URL` at a remote host, never use the test seams with real
`data/`, and never place a real key in a mock or test fixture.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `requires Node.js 22.19 or newer` | Run `nvm install && nvm use`, then `node -v`. `npm run check:runtime` checks without starting the app. |
| `EADDRINUSE` or the server exits with a lock error | Another process is using the port or `DATA_DIR`. Stop the other server. A second server on the same data directory is intentionally refused. |
| `/api/health` returns 503 | The server does not hold `data/.server.lock`, or the request reached the wrong process/port. Check the configured origin and restart. |
| Invalid `APP_ORIGIN` | Use `http://127.0.0.1:<port>` or another loopback host with an explicit non-default port, with no path/query. Restart with the same value. |
| `Chrome not found`, `Chrome exited`, or no display | Install Google Chrome/Chromium, enable WSLg or an X server, and check `DISPLAY`/`WAYLAND_DISPLAY`. The standalone smoke scripts add hints; the application's `/agent` path may show only the bounded SDK launch error. For a non-interactive browser check use the headless smoke. |
| Key validation fails with 401 | The key is invalid or not an inference key. Replace it. A management-only key cannot run inference or images. |
| Image generation stops with 402 | The account balance is below the image API's $1-per-request floor. Add credit or choose a verifiably priced model. |
| Quote is blocked (`unknown-price`, `stale-model`, `unverified-capabilities`) | The selected model metadata or account entitlement could not be verified. Recheck the model ID/capabilities and quote. No paid request was made. |
| Agent says verification is required | Use **Verify agent model** on `/agent` after entering a key. A key/model/SDK/origin change invalidates the old stamp. |
| Agent gate reports a model/origin/SDK mismatch | The stamp belongs to a different tuple. Restore the matching setting or re-verify. A stamp does not transfer between data directories. |
| Vision shows `Unverified` | Expected unless a tool result actually carried image content. A text heading answer is not vision evidence. |
| Agent run is `hung`, or a browser process remains | Restart the app and let startup recovery verify/terminate the recorded group. Inspect `data/agent-recovery.json`, `data/locks/paid-job.lock`, and `data/browser-profiles/`. Do not delete locks before confirming processes are gone. |
| Corrupt saved state | Inspect the named JSON file under `data/`; the app reports corruption rather than discarding data. Fix or restore the file, or perform a deliberate full reset. |
| Layout shows Classic despite a saved choice, or the layout cannot change | Inspect `data/ui-settings.json`. A corrupt optional layout setting falls back to Classic on catalog/form/agent pages with a warning and blocks a new agent run as `state-unreadable`; fix or remove the file deliberately. A `409 paid-operation-active` response means an image batch, agent run, or another layout change is active. |
| Image or job state is incomplete after a crash | Restart once so local recovery can reconcile matching attempts and mark the job interrupted. Then use a fresh quote and confirmation to resume. |
| E2E refuses a base-URL override | The override requires `LAB_TEST_MODE=1` and a disposable `DATA_DIR` under the OS temp root outside the project. Use the provided `npm run test:e2e` harness instead of a real data directory. |
| Dev server behaves oddly after a production build | Stop it and remove only the dev cache (`.next/dev`), then restart. Do not delete `data/` to fix a cache issue. |

## Scope limits

- The app is a local demonstration, not a production storefront. There is no checkout,
  payment, email, authentication, or multi-user isolation.
- One server per data directory and one paid operation at a time are enforced. Agent runs
  are limited to one active run.
- Paid live image/agent acceptance remains separately approved and unverified until
  actually observed. The optional alternate UI is implemented; the optional resilience
  comparison is not part of the core implementation.
