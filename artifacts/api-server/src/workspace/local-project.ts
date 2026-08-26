import type { ChangeProposalFile } from "../ai/change-proposal";
import { changeStats } from "./local-workspace";

type GeneratedFile = { path: string; language: string; proposedCode: string; explanation: string };

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function projectKind(request: string) {
  const text = request.toLowerCase();
  if (text.includes("calculator") || text.includes("calculate")) return "calculator";
  if (text.includes("todo") || text.includes("to-do") || text.includes("task list")) return "todo";
  if (text.includes("react") || text.includes("vite")) return "react";
  return "page";
}

export function generateLocalProject(request: string): GeneratedFile[] {
  const kind = projectKind(request);
  const title = kind === "calculator" ? "Calculator" : kind === "todo" ? "Todo List" : kind === "react" ? "React Workspace" : "Local Project";
  if (kind === "react") {
    return [
      { path: "package.json", language: "json", proposedCode: JSON.stringify({ private: true, type: "module", scripts: { dev: "vite" }, dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" }, devDependencies: { vite: "^7.0.0" } }, null, 2), explanation: "Defines a real Vite development project with React runtime dependencies." },
      { path: "index.html", language: "html", proposedCode: `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`, explanation: "Provides the Vite HTML entry point." },
      { path: "src/main.jsx", language: "javascript", proposedCode: `import React, { useState } from "react";\nimport { createRoot } from "react-dom/client";\nimport "./styles.css";\n\nfunction App() {\n  const [count, setCount] = useState(0);\n  return <main className="card"><p className="eyebrow">Vite + React</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(request)}</p><button onClick={() => setCount((value) => value + 1)}>Clicked {count} times</button></main>;\n}\n\ncreateRoot(document.getElementById("root")).render(<App />);`, explanation: "Creates a functional React entrypoint with a verifiable interactive state update." },
      { path: "src/styles.css", language: "css", proposedCode: `:root{font-family:Inter,system-ui,sans-serif;color:#e8f1ef;background:#0b1518}body{min-height:100vh;display:grid;place-items:center;margin:0;background:radial-gradient(circle at top,#1b383c,#0b1518 70%);padding:24px}.card{width:min(640px,90vw);padding:32px;border:1px solid #315155;border-radius:18px;background:#132326;box-shadow:0 20px 70px #0006}.eyebrow{color:#f3a27e;text-transform:uppercase;letter-spacing:.12em;font-size:11px}h1{font-size:clamp(2rem,6vw,4rem);margin:8px 0 16px}p{color:#a9beb9;line-height:1.6}button{border:1px solid #70cdb8;border-radius:8px;padding:11px 16px;color:#09201c;background:#a7e1cf;font-weight:800;cursor:pointer}button:hover{background:#d6fff0}`, explanation: "Adds the responsive visual styling for the React project." },
    ];
  }
  const behavior = kind === "calculator"
    ? `const display = document.querySelector("#display"); let expression = ""; document.querySelectorAll("[data-value]").forEach((button) => button.addEventListener("click", () => { const value = button.dataset.value; if (value === "clear") expression = ""; else if (value === "equals") { try { expression = String(Function("return " + expression)()); } catch { expression = "Error"; } } else expression += value ?? ""; display.textContent = expression || "0"; }));`
    : kind === "todo"
      ? `const form = document.querySelector("#todo-form"), input = document.querySelector("#todo-input"), list = document.querySelector("#todo-list"); form.addEventListener("submit", (event) => { event.preventDefault(); const value = input.value.trim(); if (!value) return; const item = document.createElement("li"); item.textContent = value; item.addEventListener("click", () => item.classList.toggle("done")); list.append(item); input.value = ""; });`
      : `document.querySelector("#request").textContent = ${JSON.stringify(request)};`;
  const body = kind === "calculator"
    ? `<section class="card calculator"><h1>Calculator</h1><output id="display">0</output><div class="keys">${["7","8","9","+","4","5","6","-","1","2","3","*","0",".","/","clear","equals"].map((key) => `<button data-value="${key}">${key === "equals" ? "=" : key === "clear" ? "C" : key}</button>`).join("")}</div></section>`
    : kind === "todo"
      ? `<section class="card"><h1>Todo List</h1><form id="todo-form"><input id="todo-input" placeholder="Add a task" autocomplete="off"><button>Add</button></form><ul id="todo-list"></ul><p>Click a task to mark it complete.</p></section>`
      : `<section class="card"><p class="eyebrow">Local workspace</p><h1>${escapeHtml(title)}</h1><p id="request">${escapeHtml(request)}</p><button onclick="document.body.classList.toggle('focused')">Try the interaction</button></section>`;
  const files: GeneratedFile[] = [
    { path: "index.html", language: "html", proposedCode: `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="style.css"></head><body>${body}<script src="app.js"></script></body></html>`, explanation: "Creates the application entry point and accessible interface." },
    { path: "style.css", language: "css", proposedCode: `:root{font-family:Inter,system-ui,sans-serif;color:#e8f1ef;background:#0b1518}body{min-height:100vh;display:grid;place-items:center;margin:0;background:radial-gradient(circle at top,#1b383c,#0b1518 70%);padding:24px}.card{width:min(640px,90vw);padding:32px;border:1px solid #315155;border-radius:18px;background:#132326;box-shadow:0 20px 70px #0006}.eyebrow{color:#f3a27e;text-transform:uppercase;letter-spacing:.12em;font-size:11px}h1{font-size:clamp(2rem,6vw,4rem);margin:8px 0 16px}p{color:#a9beb9;line-height:1.6}button{border:0;border-radius:8px;padding:11px 15px;background:#f3a27e;color:#1d1515;font-weight:700;cursor:pointer}.keys{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:18px}.keys button{font-size:18px}.calculator output{display:block;min-height:45px;padding:12px;background:#0b1518;border-radius:8px;text-align:right;font:28px monospace}.calculator input{padding:10px}.done{text-decoration:line-through;opacity:.6}`, explanation: "Provides responsive styling and clear visual hierarchy." },
    { path: "app.js", language: "javascript", proposedCode: behavior, explanation: "Adds the requested interaction using browser-safe client code." },
  ];
  return files;
}

export async function toLocalProposalFiles(files: GeneratedFile[], readExisting: (path: string) => Promise<string>): Promise<ChangeProposalFile[]> {
  return Promise.all(files.map(async (file) => {
    let originalCode = "";
    let operation: "create" | "edit" = "create";
    try { originalCode = await readExisting(file.path); operation = "edit"; } catch { /* create */ }
    const stats = operation === "create" ? { addedLines: file.proposedCode.split("\n").length, removedLines: 0 } : changeStats(originalCode, file.proposedCode);
    const diff = operation === "create"
      ? `--- /dev/null\n+++ b/${file.path}\n@@ create @@\n+${file.proposedCode}`
      : `--- a/${file.path}\n+++ b/${file.path}\n@@ change @@\n-${originalCode}\n+${file.proposedCode}`;
    return { ...file, originalCode, operation, diff, ...stats };
  }));
}