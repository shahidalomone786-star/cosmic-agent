import { spawn } from "node:child_process";
import process from "node:process";

const baseUrl = (process.env.COSMIC_SMOKE_URL ?? "http://127.0.0.1:80").replace(/\/$/, "");
const chromium = process.env.CHROMIUM_BIN ?? "chromium";
const debugPort = Number(process.env.COSMIC_SMOKE_DEBUG_PORT ?? 9229);
const userDataDir = `/tmp/cosmic-agent-control-center-smoke-${process.pid}`;
const email = `control-center-smoke-${process.pid}-${Date.now()}@example.invalid`;
const password = `Smoke-${process.pid}-Pass!`;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForJson(url, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Chromium is still starting.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function registerSmokeSession() {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`Smoke session registration failed with HTTP ${response.status}.`);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/(?:^|,\s*)cosmic_session=([^;]+)/);
  if (!match?.[1]) throw new Error("Smoke session registration did not return a session cookie.");
  return match[1];
}

async function openPage() {
  const child = spawn(chromium, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    baseUrl,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  try {
    const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json`);
    const target = targets.find((item) => item.type === "page");
    if (!target?.webSocketDebuggerUrl) throw new Error("Chromium did not expose a page target.");
    return { child, target, stderr };
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr.join("")}`);
  }
}

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 0;
  const pending = new Map();
  const events = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else {
      events.push(message);
    }
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Chromium DevTools connection failed.")), { once: true });
  });
  const command = async (method, params = {}) => {
    await ready;
    const id = ++nextId;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return { command, events, close: () => socket.close() };
}

async function evaluate(client, expression) {
  const result = await client.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Browser evaluation failed.");
  return result.result?.value;
}

async function main() {
  const sessionId = await registerSmokeSession();
  const { child, target, stderr } = await openPage();
  const client = createCdpClient(target.webSocketDebuggerUrl);
  try {
    await client.command("Runtime.enable");
    await client.command("Network.enable");
    await client.command("Page.enable");
    await client.command("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await client.command("Page.navigate", { url: baseUrl });
    await sleep(2_000);
    const unauthenticatedText = await evaluate(client, "document.body.innerText");
    if (!unauthenticatedText.includes("Welcome back") || !unauthenticatedText.includes("Sign in")) {
      throw new Error("Unauthenticated load did not render the login screen.");
    }
    if (unauthenticatedText.includes("Session check") || unauthenticatedText.includes("connection problem")) {
      throw new Error("Unauthenticated load rendered an auth diagnostic/error state.");
    }
    const unauthenticatedErrors = client.events.filter((event) => event.method === "Runtime.consoleAPICalled" && event.params?.type === "error");
    const unauthenticatedExceptions = client.events.filter((event) => event.method === "Runtime.exceptionThrown");
    if (unauthenticatedErrors.length || unauthenticatedExceptions.length) {
      throw new Error(`Unauthenticated load emitted browser errors (${unauthenticatedErrors.length} console errors, ${unauthenticatedExceptions.length} exceptions).`);
    }
    await client.command("Network.setCookie", {
      name: "cosmic_session",
      value: sessionId,
      url: baseUrl,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    });
    await client.command("Page.navigate", { url: baseUrl });
    await sleep(2_500);

    const initialText = await evaluate(client, "document.body.innerText");
    if (!initialText.includes("Cosmic Agent")) throw new Error("Authenticated app shell did not render.");
    const settingsButton = await evaluate(client, "document.querySelector('[aria-label=\"Open settings\"]') !== null");
    if (!settingsButton) throw new Error("Authenticated account settings control did not render.");
    await evaluate(client, "document.querySelector('[aria-label=\"Open settings\"]').click()");
    await sleep(1_500);

    const text = await evaluate(client, "document.body.innerText");
    for (const category of ["DEVELOPMENT", "SOURCE CONTROL", "DATA & INTEGRATIONS", "SECURITY", "ACCOUNT"]) {
      if (!text.includes(category)) throw new Error(`Control Center category missing: ${category}.`);
    }
    if (!text.includes("DISABLED — INTENTIONALLY RESTRICTED")) {
      throw new Error("Control Center disabled-module reason text is missing.");
    }
    const drawerState = await evaluate(client, `(() => {
      const drawer = document.querySelector('.control-center');
      const backdrop = document.querySelector('.settings-overlay');
      if (!drawer || !backdrop) return { ok: false, reason: 'drawer or backdrop missing' };
      const drawerRect = drawer.getBoundingClientRect();
      const backdropRect = backdrop.getBoundingClientRect();
      const drawerStyle = getComputedStyle(drawer);
      const backdropStyle = getComputedStyle(backdrop);
      const topLayer = document.elementFromPoint(5, 5);
      const mainStyle = getComputedStyle(document.querySelector('.control-center-main'));
      return {
        ok: drawerRect.width >= window.innerWidth && drawerRect.height >= window.innerHeight
          && backdropRect.width >= window.innerWidth && backdropRect.height >= window.innerHeight
          && drawerStyle.position === 'fixed'
          && Number(drawerStyle.zIndex) > Number(backdropStyle.zIndex)
          && backdropStyle.backdropFilter !== 'none'
          && document.body.style.overflow === 'hidden'
          && (topLayer === drawer || drawer.contains(topLayer))
          && drawerStyle.overflow === 'hidden'
          && mainStyle.overflowY === 'auto',
        drawerWidth: drawerRect.width,
        drawerHeight: drawerRect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        drawerZ: drawerStyle.zIndex,
        backdropZ: backdropStyle.zIndex,
        topLayer: topLayer?.className ?? topLayer?.tagName,
        bodyOverflow: document.body.style.overflow,
        mainOverflow: mainStyle.overflowY,
      };
    })()`);
    if (!drawerState.ok) throw new Error(`Control Center modal layering failed: ${JSON.stringify(drawerState)}.`);
    await evaluate(client, "document.querySelector('[aria-label=\"Close Control Center\"]').click()");
    await sleep(400);
    const closedState = await evaluate(client, `({
      drawer: Boolean(document.querySelector('.control-center')),
      backdrop: Boolean(document.querySelector('.settings-overlay')),
      bodyOverflow: document.body.style.overflow,
    })`);
    if (closedState.drawer || closedState.backdrop || closedState.bodyOverflow) {
      throw new Error(`Control Center did not fully close and restore page interaction: ${JSON.stringify(closedState)}.`);
    }
    const errors = client.events.filter((event) => event.method === "Runtime.consoleAPICalled" && event.params?.type === "error");
    const exceptions = client.events.filter((event) => event.method === "Runtime.exceptionThrown");
    if (errors.length || exceptions.length) {
      throw new Error(`Browser console errors detected (${errors.length} console errors, ${exceptions.length} exceptions).`);
    }
    console.log(`Control Center authenticated smoke passed for ${email}.`);
  } finally {
    client.close();
    child.kill("SIGTERM");
    await sleep(100);
    if (stderr.length && process.env.COSMIC_SMOKE_VERBOSE === "1") process.stderr.write(stderr.join(""));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});