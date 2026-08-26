import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChangeProposal } from "../ai/change-proposal";

export type LocalValidation = {
  status: "pass" | "fail";
  summary: string;
  checks: Array<{ name: "typecheck" | "build"; status: "pass" | "fail"; details: string }>;
  files: string[];
};

const MAX_OUTPUT = 2_000;
const blocked = /(^|\/)(\.git|node_modules|\.env(?:\..*)?|secrets?|credentials?)(\/|$)|(^|\/).*?\.(pem|key|p12|pfx|crt)$/i;

export async function validateLocalWorkspace(root: string, proposal: ChangeProposal): Promise<LocalValidation> {
  const fileErrors: string[] = [];
  for (const file of proposal.files) {
    const target = path.join(root, file.path);
    try {
      if (file.operation === "directory_create") {
        const stat = await fs.stat(target);
        if (!stat.isDirectory()) fileErrors.push(`${file.path} is not a directory.`);
      } else if (file.operation === "delete") {
        if (await exists(target)) fileErrors.push(`${file.path} was not deleted.`);
      } else if (file.operation === "rename") {
        const source = path.join(root, file.fromPath ?? "");
        if (!(await exists(target))) fileErrors.push(`Rename destination ${file.path} is missing.`);
        if (await exists(source)) fileErrors.push(`Rename source ${file.fromPath} still exists.`);
      } else {
        const content = await fs.readFile(target, "utf8");
        if (content !== file.proposedCode) fileErrors.push(`${file.path} does not match the approved content.`);
      }
    } catch {
      fileErrors.push(`${file.path} is missing after the approved operation.`);
    }
  }
  if (fileErrors.length) return failed(fileErrors.join(" "));

  const sourceFiles = await collectTextFiles(root);
  const syntaxErrors: string[] = [];
  for (const file of sourceFiles.filter((item) => /\.(?:mjs|cjs|js)$/i.test(item))) {
    const result = await run("node", ["--check", file], root, 8_000);
    if (!result.ok) syntaxErrors.push(`${path.relative(root, file)}: ${result.output}`);
  }
  const referenceErrors = await checkHtmlReferences(root, sourceFiles);
  if (syntaxErrors.length || referenceErrors.length) {
    return failed([...syntaxErrors, ...referenceErrors].slice(0, 8).join(" "));
  }

  const packagePath = path.join(root, "package.json");
  const hasPackage = await exists(packagePath);
  let manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined;
  if (hasPackage) {
    try { manifest = JSON.parse(await fs.readFile(packagePath, "utf8")); }
    catch { return failed("package.json is not valid JSON."); }
  }
  const hasTypeScript = Boolean(manifest?.dependencies?.typescript || manifest?.devDependencies?.typescript || await exists(path.join(root, "tsconfig.json")));
  const hasVite = Boolean(manifest?.dependencies?.vite || manifest?.devDependencies?.vite || await exists(path.join(root, "vite.config.ts")) || await exists(path.join(root, "vite.config.js")));
  const checks: LocalValidation["checks"] = [];
  if (hasTypeScript) {
    const typecheck = await run("pnpm", ["exec", "tsc", "--noEmit"], root, 20_000);
    checks.push({ name: "typecheck", status: typecheck.ok ? "pass" : "fail", details: typecheck.ok ? "TypeScript completed successfully." : typecheck.output });
    if (!typecheck.ok) return { status: "fail", summary: "Local typecheck failed. A new fix proposal is required.", checks, files: proposal.affectedFiles };
  } else {
    checks.push({ name: "typecheck", status: "pass", details: "Text workspace checks completed; no TypeScript project was detected." });
  }
  if (hasVite) {
    const build = await run("pnpm", ["exec", "vite", "build"], root, 30_000);
    checks.push({ name: "build", status: build.ok ? "pass" : "fail", details: build.ok ? "Vite build completed successfully." : build.output });
    if (!build.ok) return { status: "fail", summary: "Local build failed. A new fix proposal is required.", checks, files: proposal.affectedFiles };
  } else {
    const entry = sourceFiles.find((item) => path.basename(item).toLowerCase() === "index.html");
    checks.push({ name: "build", status: entry ? "pass" : "fail", details: entry ? "HTML entry point and linked source files are present." : "No supported index.html entry point was found." });
    if (!entry) return { status: "fail", summary: "Local build failed because no supported entry point was found. A new fix proposal is required.", checks, files: proposal.affectedFiles };
  }
  return { status: "pass", summary: "Approved local operations passed deterministic type and build validation.", checks, files: proposal.affectedFiles };
}

async function checkHtmlReferences(root: string, sourceFiles: string[]): Promise<string[]> {
  const known = new Set(sourceFiles.map((file) => path.resolve(file)));
  const errors: string[] = [];
  for (const file of sourceFiles.filter((item) => /\.html?$/i.test(item))) {
    const content = await fs.readFile(file, "utf8");
    for (const reference of [...content.matchAll(/(?:src|href)=["']([^"']+)["']/gi)].map((match) => match[1])) {
      if (/^(?:[a-z]+:|#|\/?\/|data:|mailto:|javascript:)/i.test(reference)) continue;
      const candidate = path.resolve(path.dirname(file), reference.split("?")[0].split("#")[0]);
      if (!candidate.startsWith(path.resolve(root) + path.sep) || blocked.test(path.relative(root, candidate)) || !known.has(candidate)) {
        errors.push(`${path.relative(root, file)} references missing ${reference}.`);
      }
    }
  }
  return errors;
}

async function collectTextFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    if (files.length >= 500) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = path.relative(root, path.join(directory, entry.name)).replaceAll("\\", "/");
      if (blocked.test(relative) || entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && /\.(?:html?|css|js|mjs|cjs|json|ts|tsx|jsx|md)$/i.test(entry.name)) files.push(target);
      if (files.length >= 500) return;
    }
  };
  await walk(root);
  return files;
}

function failed(details: string): LocalValidation {
  return {
    status: "fail",
    summary: "Local validation failed. A new fix proposal is required.",
    checks: [{ name: "typecheck", status: "fail", details }, { name: "build", status: "fail", details: "Build was not run after the preceding validation failure." }],
    files: [],
  };
}

async function exists(filePath: string): Promise<boolean> {
  try { await fs.lstat(filePath); return true; } catch { return false; }
}

function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: "pipe",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CI: "1", NODE_ENV: "development" },
    });
    let output = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve({ ok: false, output: "Validation command timed out." }); }, timeoutMs);
    child.stdout.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-MAX_OUTPUT); });
    child.stderr.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-MAX_OUTPUT); });
    child.once("error", (error) => { clearTimeout(timer); resolve({ ok: false, output: error.message }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: output.trim() || (code === 0 ? "Passed" : "Validation failed.") }); });
  });
}