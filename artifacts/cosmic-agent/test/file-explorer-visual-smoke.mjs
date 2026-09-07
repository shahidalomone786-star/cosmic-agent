import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const baseUrl = (process.env.COSMIC_SMOKE_URL ?? "http://127.0.0.1:80").replace(/\/$/, "");
const chromium = process.env.CHROMIUM_BIN ?? "chromium";
const debugPort = Number(process.env.COSMIC_FILE_VISUAL_DEBUG_PORT ?? 9231);
const userDataDir = `/tmp/cosmic-agent-file-visual-${process.pid}`;
const email = `file-visual-smoke-${process.pid}-${Date.now()}@example.invalid`;
const password = `File-${process.pid}-Visual!`;
const syntaxFile = `phase1282-${process.pid}.ts`;
const markdownFile = `phase1282-${process.pid}.md`;
const jsonFile = `phase1282-${process.pid}.json`;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForJson(url, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function registerSession() {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`Visual smoke registration failed with HTTP ${response.status}.`);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/(?:^|,\s*)cosmic_session=([^;]+)/);
  if (!match?.[1]) throw new Error("Visual smoke registration did not return a session cookie.");
  return match[1];
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
    } else events.push(message);
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
  if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.exception?.description ?? "Browser evaluation failed."} Expression: ${expression}`);
  return result.result?.value;
}

async function waitFor(client, expression, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for browser condition: ${expression}`);
}

async function click(client, selector) {
  await evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error(${JSON.stringify(`Missing ${selector}`)});
    element.click();
    return true;
  })()`);
}

async function fill(client, selector, value) {
  await evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error(${JSON.stringify(`Missing ${selector}`)});
    const setter = element instanceof HTMLTextAreaElement
      ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
}

async function capture(client, filePath) {
  const result = await client.command("Page.captureScreenshot", { format: "jpeg", quality: 84, fromSurface: true });
  await writeFile(filePath, Buffer.from(result.data, "base64"));
}

async function main() {
  const sessionId = await registerSession();
  const child = spawn(chromium, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, baseUrl,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const target = (await waitForJson(`http://127.0.0.1:${debugPort}/json`)).find((item) => item.type === "page");
  if (!target?.webSocketDebuggerUrl) throw new Error("Chromium did not expose a page target.");
  const client = createCdpClient(target.webSocketDebuggerUrl);

  try {
    await client.command("Runtime.enable");
    await client.command("Page.enable");
    await client.command("Network.setCookie", { name: "cosmic_session", value: sessionId, url: baseUrl, path: "/", httpOnly: true, sameSite: "Lax" });
    await client.command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await client.command("Page.navigate", { url: `${baseUrl}/files` });
    await waitFor(client, "Boolean(document.querySelector('[data-testid=\"page-file-explorer\"]'))", 12_000);
    await waitFor(client, "Boolean(document.querySelector('.file-tree'))");
    await capture(client, "../../screenshots/phase1282-file-explorer-empty.jpg");

    const files = [
      { path: syntaxFile, content: [
        'export const greeting: string = "Cosmic Agent";',
        '',
        'export function boot(name: string) {',
        '  const count = 3;',
        '  return greeting + ", " + name + " — run " + count;',
        '}',
        '',
      ].join('\n') },
      { path: markdownFile, content: "# Cosmic Agent\\n\\nSyntax smoke fixture.\\n" },
      { path: jsonFile, content: '{\\n  "name": "cosmic-agent",\\n  "phase": 12.8\\n}\\n' },
    ];
    await evaluate(client, `Promise.all(${JSON.stringify(files)}.map((file) => fetch("/api/workspace/default/file", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(file) }))).then(() => true)`);
    await click(client, '[aria-label="Refresh file tree"]');
    await waitFor(client, `Boolean(document.querySelector('[data-testid="file-explorer-entry-${syntaxFile}"]'))`);

    await fill(client, '.file-explorer-search input', syntaxFile);
    await waitFor(client, `Boolean(document.querySelector('[data-testid="file-explorer-entry-${syntaxFile}"]'))`);
    await capture(client, "../../screenshots/phase1282-file-explorer-search.jpg");

    await click(client, `[data-testid="file-explorer-entry-${syntaxFile}"]`);
    await waitFor(client, "Boolean(document.querySelector('[data-testid=\"code-editor-file-explorer\"]'))");
    const syntax = await evaluate(client, `(() => {
      const spans = [...document.querySelectorAll('[data-testid="code-editor-file-explorer"] .cm-content span')];
      const colors = [...new Set(spans.map((span) => getComputedStyle(span).color).filter(Boolean))];
      return { tokenSpans: spans.length, distinctColors: colors.length, text: document.querySelector('[data-testid="code-editor-file-explorer"]')?.textContent ?? "" };
    })()`);
    if (syntax.tokenSpans < 3 || syntax.distinctColors < 2 || !syntax.text.includes("greeting")) {
      throw new Error(`Syntax highlighting did not render tokenized source: ${JSON.stringify(syntax)}`);
    }
    await capture(client, "../../screenshots/phase1282-file-explorer-editor-syntax.jpg");

    await client.command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(300);
    await capture(client, "../../screenshots/phase1282-file-explorer-mobile.jpg");

    const errors = client.events.filter((event) => event.method === "Runtime.consoleAPICalled" && event.params?.type === "error");
    const exceptions = client.events.filter((event) => event.method === "Runtime.exceptionThrown");
    if (errors.length || exceptions.length) throw new Error(`Browser errors detected (${errors.length} console errors, ${exceptions.length} exceptions).`);
    console.log(`File Explorer visual/syntax smoke passed for ${email}.`);
    console.log(JSON.stringify({ syntax, screenshots: ["empty", "search", "editor-syntax", "mobile"] }));
  } finally {
    await evaluate(client, `Promise.all(${JSON.stringify([syntaxFile, markdownFile, jsonFile])}.map((path) => fetch("/api/workspace/default/file?path=" + encodeURIComponent(path), { method: "DELETE", credentials: "include" }))).catch(() => null)`).catch(() => {});
    client.close();
    child.kill("SIGTERM");
    await sleep(100);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});