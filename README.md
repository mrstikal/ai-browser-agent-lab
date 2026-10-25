# AI Browser Agent Lab

This local demo uses a small storefront as a controlled environment for an AI browser
agent. It shows the difference between **generating content** (product images),
**performing actions** (navigating pages and submitting forms in a local Chromium
browser), and **checking results** (comparing the agent's answer and local records with
fixed, server-side expectations). Run the same tasks in two layouts to explore how a
change in presentation affects browser automation without changing the underlying data.

The 24 products, prices, stock levels, and catalog task answers are deterministic;
form tasks are checked against new local records. OpenRouter generates images, not
catalog facts. Form submissions and agent runs stay in a local, Git-ignored `data/`
directory. This is a single-user experiment, not a real store: it has no
checkout, payments, email delivery, authentication, cloud browser, or external database.
Keep it bound to loopback, not a LAN or public interface.

## How the demo fits together

1. [Start the server](#quick-start-from-a-fresh-clone) without a key and browse the
   storefront with image placeholders.
2. [Optionally generate product images](#first-run-setup-and-image-generation) after
   configuring OpenRouter, reviewing a live quote, and explicitly accepting the cost.
   The product data does not change when images arrive.
3. [Explore the catalog and test forms](#storefront-and-forms) to see the pages and local
   records that the agent will later interact with.
4. [Verify the browser model](#verify-the-browser-model-first) against a fixed local
   heading task, then [run one of five presets](#run-tasks-and-read-results) to test
   navigation, filtering, ordering, or form submission.
5. [Switch layouts and compare runs](#mode-resilience-comparison). The dashboard
   separates process completion, correct business results, and recorded page actions;
   repeated runs are descriptive samples, not a statistical verdict.

Steps 2, 4, and any live repetition in step 5 use your OpenRouter account and may cost
money. Starting the server, browsing the fixed catalog, and submitting the two local
test forms do not require a key or a paid model call.

## Technologies and why they matter

- **Next.js App Router, React, TypeScript, and Tailwind CSS** serve the storefront,
  setup wizard, forms, and agent dashboard from one typed application. The same product
  data and guarded server routes support both layouts.
- **OpenRouter** supplies image generation and the browser agent's model. Separate model
  choices share one API-key/account boundary; the image flow shows a quote before paid
  requests.
- **`@browser_use/pi` and installed Chromium** let the agent act on actual local pages.
  Browser navigation and form interaction can be examined separately from the model's
  final text. The browser is local, not hosted.
- **Zod and `sharp`** validate inputs/records and decode generated image bytes. Malformed
  form data, settings, answers, or images are rejected before use.
- **Local filesystem and Server-Sent Events (SSE)** store images, submissions, jobs,
  runs, and traces without a database. Progress streams to the UI, with a GET fallback
  if a stream disconnects; saved work survives refreshes.
- **Vitest, Playwright, and a loopback OpenRouter mock** exercise logic and browser
  workflows with disposable data, without a real API key or paid provider calls.

## Requirements

### Node.js

- Node.js **22.19 or newer** is required. The tested default is `22.22.2` (`.nvmrc`).
- `package.json` declares `engines.node >= 22.19`, `.npmrc` enables `engine-strict`, and
  the `dev`, `build`, `start`, and browser-test entry points check the runtime before use.
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
- An [OpenRouter account and API key](https://openrouter.ai/keys) are needed only when
  you choose to generate images or run the model-backed browser agent. Check your account
  credit and set an account-side spending limit before paid actions.
- Normal application traffic leaves the machine only for explicitly approved OpenRouter
  requests. Next.js telemetry is disabled.
- npm with the committed lockfile is the supported package manager.

## Quick start from a fresh clone

Replace `<repository-url>` with the clone URL you have access to:

```bash
git clone <repository-url> ai-browser-agent-lab
cd ai-browser-agent-lab
nvm install
nvm use
npm ci
npm run dev
```

Open <http://127.0.0.1:3000>. No API key, pre-existing `data/` directory, or provider
account is needed to start the server. The catalog and forms are usable with image
placeholders, even if you skip image generation. On a new data directory, `/` redirects
to `/setup`; use the navigation to browse `/shop` at any time.

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

Built `start` uses the same origin, storage, worker, and recovery paths as `dev`. Build
first; `npm run start` does not build for you.

### A different loopback port

```bash
APP_ORIGIN=http://127.0.0.1:3100 npm run dev
```

`APP_ORIGIN` must be an origin only: `http`, a loopback host (`127.0.0.1`, `localhost`, or
`[::1]`), and an explicit port, with no path, query, credentials, or fragment. The same
value drives the Next bind address, the Host/Origin mutation guard, and the agent's start
URL. Use one origin consistently for the browser tab, agent runs, and tests.

## First-run setup and image generation

The setup wizard turns the fixed catalog into an image-rich storefront. Image generation
is optional and paid; neither product names nor catalog answers are generated by AI.
This distinction makes the later browser tasks independently checkable. The agent can
work with image placeholders too, once its browser model has been verified.

1. Open `/setup`.
2. Enter an OpenRouter API key. The app checks it through a non-billable
   `GET https://openrouter.ai/api/v1/key` request; validation alone does not prove
   inference access. **Remember API Key is off by default**: the server keeps the key in
   memory across page refreshes, but you must re-enter it after a restart. If enabled,
   Remember stores plaintext at `data/secrets/openrouter-key` (mode `0600` where
   supported), **not encrypted**. WSL, network filesystems, and other mounts may not
   enforce equivalent permissions. A management-only key cannot run inference or
   generate images. Key changes are refused during paid work and invalidate browser
   verification.
3. Choose separate image and browser models. The defaults are
   `black-forest-labs/flux-3-image-klein` for images and
   `openrouter/openai/gpt-5.6-luna` for the browser agent. The image choice controls
   visuals, not product facts; the browser choice controls the agent's reasoning.
   Image-model capabilities and price are checked against live metadata when quoting.
   A saved browser-model ID is only format-checked; actual access needs the paid browser
   verification run.
4. Review the current image quote. It shows the target count, unit price, base estimate, the
   worst case with up to two retries per image, and the indicative starting balance needed
   to keep $1 available before **each** image request. The quote is not an account-side
   spending cap.
5. Check the cost-confirmation box and start the batch. The server rechecks the quoted
   selection and targets before it sends paid requests. The initial batch targets only
   missing images; **Resume missing images** and **Retry failed images** require a new
   quote and confirmation. Requests run sequentially, with up to two retries for
   transient failures.
6. Watch per-product progress and failures, plus the aggregate cost breakdown, on
   `/setup`. SSE updates the page; a read-only GET fallback works if the stream
   disconnects. Image bytes are decoded and validated before publication. The catalog
   replaces placeholders with valid images; refreshing or restarting does not regenerate
   them automatically.

### Costs

**All OpenRouter usage is charged to your OpenRouter account.** The application cannot
provide a provider invoice or a hard account-side spending cap.

- The image quote is computed from the selected model's live endpoint metadata and an
  exact fixed-point USD price. Unknown or stale pricing blocks generation instead of
  showing `$0`.
- Illustration, **not a current price**: at $0.008 per image, 24 images cost $0.192
  for one attempt each or $0.576 if each needs three attempts. Indicative starting
  balances are $1.184 and $1.568 respectively, because $1 must remain before each
  request. Always use the quote displayed for your own model and targets.
- The image API can return HTTP 402 when the available balance is below $1 before a
  request, even if the projected batch costs less. Stop on 402, add credit, and obtain a
  fresh quote before continuing; a cheaper model does not remove the $1 floor.
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
- A completed batch requires every targeted image to succeed and all 24 active files to
  validate. After a failed batch, previously valid images may still be
  available in the storefront; job status and available images are distinct.

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

1. **Browse `/shop`.** The catalog contains exactly 24 fixed products, six per
   unfiltered page across four pages. Search, category, in-stock filtering, and price
   sorting are URL-based GET controls; filtering and sorting happen before pagination.
   This gives both a human and the agent repeatable facts to inspect. Product attributes
   remain the same with or without generated images.
2. **Open a product detail page.** Its description, USD price, and stock come from the
   fixture. An unknown slug returns a real 404. The inquiry link carries the product ID
   into the form, demonstrating how the agent can follow context between pages instead
   of guessing a product.
3. **Try the local forms.** `/forms/support` collects full name, valid email, subject,
   priority and description. It validates an edit step, then shows a review step where
   the local-test confirmation must be checked before submitting. `/forms/inquiry` has
   no review step or confirmation checkbox; it collects full name, valid email, a known
   product, inquiry type and message, with the product preselected from its detail page.
   Both forms validate on the server and persist one UUID record under
   `data/submissions/` for each new request ID. The forms generate request IDs in the
   browser and reuse an ID when retrying the same submission, preventing duplicates.
   Both display **Your request ID** after submission. These records let the
   evaluator check what was actually submitted, not just what the agent claims it did.
   No email is sent and no payment is taken.
4. **Inspect `/submissions`.** Both form types appear here after submission. **Reset
   submissions** clears only support and inquiry records, leaving images, keys, settings,
   and agent history intact. The reset is refused during an active agent run or another
   paid operation. You do not have to clear old submissions before a form preset: the
   evaluator records up to 1,000 pre-run IDs for that form and checks for exactly one
   new submission. If more records of that form already exist, its preset is refused
   until you reset submissions.

### Classic and Alternate layouts

The layout switcher is available on `/shop`, both form pages, and `/agent`. Use it to
compare agent behavior when the same controls are presented differently. It is one
global local setting, so the agent's browser sees the same arrangement as your browser.

- **Classic**: catalog filters above a responsive card grid (one column on narrow
  screens, two from `sm`, three from `lg`), and single-column form fields.
- **Alternate**: catalog filters in a sidebar beside a two-column card grid, and
  two-column form fields with the long text area spanning both columns.

Both modes render the same products, labels, field names, values, validation, URLs, and
task instructions. The DOM order stays the same; only the visual arrangement changes. The
setting is stored in `data/ui-settings.json` (version, mode, and timestamp, with no
personal data) and defaults to Classic. It is not a query parameter or cookie, so it
cannot silently change a catalog or form URL.

The mode is captured from this setting at the start of each new agent run. A saved run
keeps its original mode after you switch layouts. Changing the layout briefly reserves the
same exclusive paid-operation slot: it is refused while an image batch or agent run is
active, and a run start is refused while a layout change is in flight. The mode captured at
start therefore stays stable for the whole run.

## Browser agent

The agent is a separate, model-backed process controlling an installed local Chromium
browser. It visits the same app origin you do, but its output is not accepted on trust:
the preset evaluator checks catalog facts or new local form records independently.

### Verify the browser model first

The agent uses the same server-side key as setup. **Remember can stay off**: as long as
the server process still holds the key, browser verification and agent runs can use it.
After a server restart, re-enter the key on `/setup`. Verification is a small paid
smoke task to establish that this key, model, SDK, and local origin work together before
you attempt longer browser tasks.

1. Start the app at the configured origin and open `/agent`.
2. Read the gate. Live tasks stay unavailable until the current key, browser model,
   installed SDK version, and app origin are verified.
3. In **Verify agent model**, review the separate cost warning and check the confirmation
    box. The fixed job visits the local `/shop` page and reads its `h1`. The instruction
    requests `{"heading":"Shop"}`; evaluation checks the trimmed `heading` value and
    final local URL, not an exact JSON key set. Its limits are 8 steps, 120 seconds,
    and a $0.25 soft cost limit.
4. A passing run must finish on the local `/shop` page with the expected heading. It
   writes `data/agent-compatibility.json` only if the pre-run key, model, SDK version,
   and origin still match. The record contains no key.
5. Any key replacement/deletion or browser-model change invalidates the stamp. Re-verify
   after such a change. A stamp belongs to one data directory and does not transfer to a
   fresh clone.

The verification proves browser and model access for a DOM/text task. It does **not**
prove screenshot/vision transport. The dashboard keeps vision `Unverified`; image content
from a tool result plus a later turn is not transport proof, and the app does not infer
vision from token counts or a correct answer.

### Run tasks and read results

After verification, choose a preset on `/agent`, review the instruction, limits, and
cost notice, then explicitly start a run. A custom task is also available within the same
step/time/cost limits, but it has no automatic business evaluation. Each preset exercises
a different kind of browser work:

1. **Cheapest available Home product:** Find the lowest-priced in-stock Home item. Return
   its exact name, USD price, and product URL as `name`, `priceUsd`, and `url`. The
   evaluator checks these values against the catalog; separate page evidence checks
   navigation. It tests whether the agent can compare prices, not whether it used a
   particular filter control.
2. **Out-of-stock products:** Identify every unavailable item and report the count.
   Return `names` and `count`; the evaluator checks the complete set and count, not just
   a plausible partial list.
3. **Audio under $70:** List in-stock Audio products below $70 in ascending price
   order. Return `items` containing each `name` and `priceUsd`. The evaluator checks
   both membership and order, combining multiple conditions with sorting.
4. **Support request:** Submit a local test as Alex Demo (`alex@example.com`) with
   subject "Payment confirmation issue", priority High, and description "I did not
   receive a confirmation after the simulated payment." Review the values, check the
   local-test confirmation, submit, and return `{"requestId":"<UUID>"}`. The evaluator
   compares every field and the returned ID with exactly one new saved support record;
   a plausible confirmation message alone is insufficient.
5. **Product inquiry:** Find Clarity Webcam and use its inquiry form as Alex Demo
   (`alex@example.com`), type Specifications, with message "Does this webcam support
   1080p video recording?" Return `{"confirmationId":"<UUID>"}`. The evaluator checks
   all prescribed fields and exactly one new saved inquiry record. Both forms display a
   request ID, but this task's answer key is named `confirmationId`.

Catalog expectations are derived from the server-side product fixture, not sent to the
model. Form presets include the prescribed test values in the instruction because the
agent needs to enter them. Every preset requires exactly one JSON answer in its stated
shape, without extra keys or prose. For a human cross-check, the catalog fixture expects
Pebble Plant Pot at $22 (`/shop/products/pebble-plant-pot`) for Task 1; four
out-of-stock products (Atlas Travel Backpack, Pulse Sport Earbuds, Glow Aroma Diffuser,
Aero Laptop Stand) for Task 2; and Mini Bluetooth Radio at $44 followed by Echo Mini
Speaker at $59 for Task 3.

Before each form run, the server snapshots existing submission IDs to distinguish this
run's record from previous experiments. The dashboard shows the active run, a live trace
(with a status-poll fallback), and the newest 50 stored run summaries. Selecting a saved
run loads its trace; the history payload does not include full task text, output, or
errors. Unknown usage or cost is shown as unknown, not as zero or a provider invoice.

The dashboard keeps these concepts separate:

- **Run lifecycle**: running, cancelling, hung, completed, failed, or interrupted.
- **Stop reason**: completed, max_steps, timeout, cancelled, cost_limit, context_limit,
  incomplete, or error (when the run has ended). This is distinct from lifecycle status.
- **Business evaluation**: passed, failed, or not evaluated. The fixed verification
  heading can pass and enable tasks; custom runs are not automatically evaluated.
- **UI evidence**: observed when the SDK records a browser page-action label such as
  Navigate, Click, Type, or Scroll. A label alone does not prove the action succeeded;
  the task-specific path check and independent business evaluation still matter.

A **full task pass** requires a completed lifecycle with stop reason `completed`, a passed
business evaluation, observed UI evidence, and page-specific evidence: catalog tasks
need recorded navigation ending under the local `/shop`, and form tasks need recorded
interaction ending on the corresponding form page. A completed process, or a correct
answer without relevant page actions, is not a full pass.

### Mode resilience comparison

To compare layouts, run the same preset with the same model in Classic and Alternate,
then open the comparison on `/agent`. The dashboard groups stored predefined-task
outcomes from its newest 50 runs; viewing the table never rewrites or starts a run.
Failures can reflect model behavior, cost/step limits, or missing UI evidence, so inspect
the individual trace before drawing conclusions from the counts.

- Filter by predefined task and model. Each row includes the model, task, layout mode,
  full-pass count, business-pass count, and sample size.
- **Success** is the strict full task pass, including the required page-specific UI
  evidence. A business pass with a cancelled, incomplete, or UI-unverified run is
  reported separately, not as success.
- Active runs, custom tasks, verification runs, and old runs without a captured mode are
  excluded and counted in the panel note.
- A single run is labeled **Single run**; samples below five carry **Small sample**
  and are described as descriptive only. The panel performs no significance test
  or confidence interval; do not treat a few runs as statistically reliable evidence.
- Rows for both modes remain visible even when one side has no sample, with a note that
  the pair needs terminal runs in both modes.

**Collect another sample (live)** is separate from the comparison table. Choose a
**Preset to repeat**; it starts one new paid task in the current layout with the current
verified model and requires a fresh checkbox confirmation for every repetition. Switch
the layout first to add a sample to the other mode. Repetition uses the default agent
limits, not custom limits from the task panel; the UI also shows the server hard caps;
usage is an SDK estimate, not a provider invoice, and the soft cap can be exceeded by one
response. A single run is anecdotal even if its task passes.

### Cancellation, process cleanup, and manual recovery

- **Cancel** on an active task run asks the worker to stop cooperatively. The verification
  panel has no cancel control. The supervisor waits a short grace period, then terminates
  only the verified worker process group. A run stays unavailable for a new start until
  cleanup is proven.
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
- You enter the key in the browser on `/setup`; it is sent to the local server for
  validation. The server does not return it in responses or place it in browser local
  storage, URLs, settings, run events, or logs. It passes the key to the agent child
  through a private environment channel.
- Browser Use Pi executes generated JavaScript without a security sandbox. The child
  process, prompt restrictions, and SDK hostname allowlist reduce risk but are not
  filesystem or network isolation. Use only trusted local pages, tasks, and test data.
- There is no authentication. Keep the server on loopback and do not expose the port to a
  LAN or the internet.
- Image prompts and agent task/page context are sent to OpenRouter during paid model
  calls. Use only test data in tasks and agent-filled forms; the agent may include page
  or form content in its model context. Form validation, storage, and acknowledgments
  remain local and are not AI-generated.
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

Stop the server and let any active image or agent operation settle first. Then remove only
image state:

```bash
rm -rf data/images
rm -f data/image-job.json data/image-recovery.json
```

Do **not** remove `data/secrets/openrouter-key` unless you also intend to delete the
remembered key. Restart the app; `/setup` will show a fresh quote for all missing images.
The app does not regenerate images automatically. To keep individual valid images, do not
delete the whole `data/images` directory; use **Resume missing images** or **Retry failed
images** on `/setup` for unresolved targets instead. These controls do not replace an
already valid image.

### Delete form test data

Use **Reset submissions** on `/submissions` (explicit confirmation, refused during active
paid work). To remove records manually, stop the server and remove only:

```bash
rm -rf data/submissions/support data/submissions/inquiry
```

This leaves images, keys, settings, and agent history intact.

### Full local reset

A complete reset removes everything, including a remembered key, settings, form data,
generated images, and agent history. Stop the server first and ensure no worker/browser
process or unresolved manual-cleanup barrier remains; if one does, keep `data/` and use
the [recovery instructions](#cancellation-process-cleanup-and-manual-recovery) first.

```bash
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
```

- `npm test` runs Vitest without Chromium or a real API key.
- `npm run test:e2e` starts a loopback OpenRouter mock on a free port, uses a fresh
  temporary `DATA_DIR`, runs Playwright against a loopback dev server with system Chrome,
  and removes the mock/temp data afterwards. It covers the full 24-image mock flow, forms,
  catalog, setup/progress, image delivery, agent dashboard/worker, server lock, and
  mutation guard, including the layout toggle and the mode comparison with its live
  cost confirmation.
- `npm run test:e2e:alternate` seeds the disposable test data with Alternate and reruns
  the existing catalog and form Playwright specs. The default suite starts in Classic, so
  the same assertions are proven in both arrangements. The harness options
  `--ui-mode=classic` and `--ui-mode=alternate` are test-only and must not be used
  with real `data/`.
- `npm run smoke:browser-local` launches local Chromium, reads a local heading through both
  `127.0.0.1` and `localhost`, and closes it. It uses no inference and no key. Use
  `npm run smoke:browser-local -- --headless` only for a display-less feasibility check.
- `npm run test:agent` is a no-charge health/key/consent preflight by default. A live
  heading observation requires `--live --approve-paid` and per-observation approval
  (`--approve-observation=1` and/or `2`, or an interactive yes). It honors the shared paid
  lock and stamps the app only with the current remembered key and matching tuple. Do not
  run it without explicit spending approval.
- Mock-backed tests verify local behavior, not access to your OpenRouter account or
  successful real-provider tasks. A correct text heading never establishes screenshot
  or vision support; keep any such observations separate from deterministic test results.

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
| Key validation fails with 401 | The key was rejected; check or replace it. A management-only key may pass validation but cannot run inference or generate images. |
| Image generation stops with 402 | The account balance is below the image API's $1-per-request floor. Add credit and review a fresh quote before resuming; choosing a cheaper model does not remove the floor. |
| Quote is blocked (`unknown-price`, `stale-model`, `unverified-capabilities`) | The selected model metadata or account entitlement could not be verified. Recheck the model ID/capabilities and quote. No paid request was made. |
| Agent says verification is required | Use **Verify agent model** on `/agent` after entering a key. A key/model/SDK/origin change invalidates the old stamp. |
| Agent gate reports a model/origin/SDK mismatch | The stamp belongs to a different tuple. Restore the matching setting or re-verify. A stamp does not transfer between data directories. |
| Vision shows `Unverified` | Browser verification reads text from `/shop`; it does not establish that image bytes reached the model. Image content in a tool result and a correct heading answer are not transport proof. |
| Agent run is `hung`, or a browser process remains | Restart the app and let startup recovery verify/terminate the recorded group. Inspect `data/agent-recovery.json`, `data/locks/paid-job.lock`, and `data/browser-profiles/`. Do not delete locks before confirming processes are gone. |
| Corrupt saved state | Inspect the named JSON file under `data/`; the app reports corruption rather than discarding data. Fix or restore the file, or perform a deliberate full reset. |
| Layout shows Classic despite a saved choice, or the layout cannot change | Inspect `data/ui-settings.json`. A corrupt optional layout setting falls back to Classic on catalog/form/agent pages with a warning and blocks a new agent run as `state-unreadable`; fix or remove the file deliberately. A `409 paid-operation-active` response means an image batch, agent run, or another layout change is active. |
| Comparison has no rows or only one mode | The table uses terminal predefined-task runs with a captured mode from the newest 50 runs. Run a preset in each layout. The comparison never starts runs automatically; use the live section with its cost confirmation. |
| Image or job state is incomplete after a crash | Restart once so local recovery can reconcile matching attempts and mark the job interrupted. Then use a fresh quote and confirmation to resume. |
| E2E refuses a base-URL override | The override requires `LAB_TEST_MODE=1` and a disposable `DATA_DIR` under the OS temp root outside the project. Use the provided `npm run test:e2e` harness instead of a real data directory. |
| Dev server behaves oddly after a production build | Stop it and remove only the dev cache (`.next/dev`), then restart. Do not delete `data/` to fix a cache issue. |

## Operational limits

Only one server may use a given data directory, only one paid operation may run at a
time, and only one agent run may be active. A mock-backed test or comparison of saved
runs is not evidence that your account can use a particular live model. Use the app's
own quote and confirmation for image requests, and verify the browser model on your
own origin and data directory before running live agent tasks.
