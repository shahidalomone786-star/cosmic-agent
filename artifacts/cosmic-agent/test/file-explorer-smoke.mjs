import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import process from "node:process";

const baseUrl = (process.env.COSMIC_SMOKE_URL ?? "http://127.0.0.1:80").replace(/\/$/, "");
const chromium = process.env.CHROMIUM_BIN ?? "chromium";
const debugPort = Number(process.env.COSMIC_FILE_SMOKE_DEBUG_PORT ?? 9230);
const userDataDir = `/tmp/cosmic-agent-file-explorer-smoke-${process.pid}`;
const email = `file-explorer-smoke-${process.pid}-${Date.now()}@example.invalid`;
const password = `File-${process.pid}-Explorer!`;
const fileName = `phase128-${process.pid}.md`;
const renamedFileName = `phase128-renamed-${process.pid}.md`;

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

async function registerSmokeSession() {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`File explorer smoke registration failed with HTTP ${response.status}.`);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/(?:^|,\s*)cosmic_session=([^;]+)/);
  if (!match?.[1]) throw new Error("File explorer smoke registration did not return a session cookie.");
  return match[1];
}

async function openPage() {
  const child = spawn(chromium, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, baseUrl,
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

async function waitFor(client, expression, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for browser condition: ${expression}`);
}

async function click(client, selector) {
  await evaluate(client, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error(${JSON.stringify(`Missing ${selector}`)}); element.click(); return true; })()`);
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
  const sessionId = await registerSmokeSession();
  const { child, target, stderr } = await openPage();
  const client = createCdpClient(target.webSocketDebuggerUrl);
  try {
    await client.command("Runtime.enable");
    await client.command("Network.enable");
    await client.command("Page.enable");
    await client.command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await client.command("Network.setCookie", { name: "cosmic_session", value: sessionId, url: baseUrl, path: "/", httpOnly: true, sameSite: "Lax" });
    await client.command("Page.navigate", { url: `${baseUrl}/files` });
    await waitFor(client, "Boolean(document.querySelector('[data-testid=\"page-file-explorer\"]'))", 12_000);
    await waitFor(client, "Boolean(document.querySelector('.file-tree'))", 12_000);

    const pageText = await evaluate(client, "document.body.innerText");
    if (!pageText.includes("File Explorer") || !pageText.includes("same existing server authorization boundary")) {
      throw new Error(`Dedicated File Explorer did not render its server-authorized shell. Body: ${JSON.stringify(pageText.slice(0, 800))}`);
    }

    await click(client, '[data-testid="button-new-workspace-file"]');
    await fill(client, '[data-testid="input-file-explorer-dialog"]', fileName);
    await click(client, '.file-explorer-dialog [type="submit"]');
    await waitFor(client, `Boolean(document.querySelector('[data-testid="file-explorer-entry-${fileName}"]'))`);
    await click(client, `[data-testid="file-explorer-entry-${fileName}"]`);
    await waitFor(client, "Boolean(document.querySelector('[data-testid=\"textarea-file-explorer-editor\"]'))");
    await fill(client, '[data-testid="textarea-file-explorer-editor"]', "# Phase 12.8 smoke\nworkspace CRUD is server-authorized.\n");
    await click(client, '[data-testid="button-save-file-explorer"]');
    await waitFor(client, `document.body.innerText.includes("Saved ${fileName}")`);
    const saved = await evaluate(client, `fetch("/api/workspace/default/file?path=${encodeURIComponent(fileName)}", { credentials: "include" }).then((response) => response.ok ? response.json() : null).then((file) => file?.content.includes("server-authorized") === true)`);
    if (!saved) throw new Error("Saved workspace content was not persisted.");
    await capture(client, "../../screenshots/phase128-file-explorer-authenticated-390.jpg");

    await click(client, '[aria-label="Rename selected file"]');
    await fill(client, '[data-testid="input-file-explorer-dialog"]', renamedFileName);
    await click(client, '.file-explorer-dialog [type="submit"]');
    await waitFor(client, `Boolean(document.querySelector('[data-testid="file-explorer-entry-${renamedFileName}"]'))`);
    const renamed = await evaluate(client, `fetch("/api/workspace/default/file?path=${encodeURIComponent(renamedFileName)}", { credentials: "include" }).then((response) => response.ok)`);
    if (!renamed) throw new Error("Renamed workspace file was not readable at its new path.");

    await click(client, '[aria-label="Delete selected file"]');
    await click(client, '.file-explorer-dialog [type="submit"]');
    await waitFor(client, `!document.querySelector('[data-testid="file-explorer-entry-${renamedFileName}"]')`);
    const deleted = await evaluate(client, `fetch("/api/workspace/default/file?path=${encodeURIComponent(renamedFileName)}", { credentials: "include" }).then((response) => response.status === 404)`);
    if (!deleted) throw new Error("Deleted workspace file remained readable.");

    const traversal = await evaluate(client, 'fetch("/api/workspace/default/file?path=%2e%2e%2foutside.txt", { credentials: "include" }).then((response) => response.status)');
    if (![400, 404].includes(traversal)) throw new Error(`Traversal request was not rejected: HTTP ${traversal}.`);

    const widths = [360, 390, 768, 1440];
    const responsive = [];
    for (const width of widths) {
      await client.command("Emulation.setDeviceMetricsOverride", { width, height: width < 700 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 700 });
      await sleep(250);
      responsive.push(await evaluate(client, `({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, page: Boolean(document.querySelector('[data-testid="page-file-explorer"]')) })`));
    }
    await capture(client, "../../screenshots/phase128-file-explorer-authenticated-desktop.jpg");
    if (responsive.some((item) => !item.page || item.scrollWidth > item.clientWidth + 1)) {
      throw new Error(`Responsive File Explorer check failed: ${JSON.stringify(responsive)}.`);
    }

    const githubWriteSurface = await evaluate(client, `(() => {
      const text = document.body.innerText.toLowerCase();
      return { hasCommit: text.includes("commit"), hasPush: text.includes("push"), hasGithubWriteEndpoint: [...document.querySelectorAll("form,button")].some((item) => /commit|push|write to github/i.test(item.textContent ?? "")) };
    })()`);
    if (githubWriteSurface.hasCommit || githubWriteSurface.hasPush || githubWriteSurface.hasGithubWriteEndpoint) {
      throw new Error(`GitHub write surface leaked into File Explorer: ${JSON.stringify(githubWriteSurface)}.`);
    }

    const errors = client.events.filter((event) => event.method === "Runtime.consoleAPICalled" && event.params?.type === "error");
    const exceptions = client.events.filter((event) => event.method === "Runtime.exceptionThrown");
    if (errors.length || exceptions.length) throw new Error(`Browser errors detected (${errors.length} console errors, ${exceptions.length} exceptions).`);
    console.log(`File Explorer CRUD/responsive smoke passed for ${email}.`);
    console.log(JSON.stringify({ crud: "create/edit/save/rename/delete", traversalStatus: traversal, responsive }));
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