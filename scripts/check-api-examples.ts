/**
 * check-api-examples.ts
 *
 * Type-checks and runs the TypeScript examples in api-reference/endpoints.mdx.
 *
 * check-snippets.ts renders every fence with `// @ts-nocheck`, so it only catches
 * syntax errors. The endpoints page documents copy-paste client calls, so it gets
 * a stricter gate:
 *
 *   1. Every ts/typescript fence on the page is extracted, in page order, into one
 *      module (the examples build on each other) and compiled with `strict: true`
 *      against the installed SDK, Stellar SDK, and Node types. There is no
 *      `@ts-nocheck`, no ambient `any` prelude, and no `no-check` fence allowed on
 *      the page.
 *   2. Network responses come from typed fixtures in
 *      scripts/fixtures/api-endpoint-responses.json. Each fixture names a response
 *      type declared on the page, and its body is compiled with `satisfies <type>`,
 *      so a fixture that drifts from the documented shape fails the check.
 *   3. The module then runs offline against a fetch stub that serves those
 *      fixtures. Every request must target a route documented on the page, send
 *      the `Authorization: Bearer` header, and match the next unused fixture for
 *      that method and path. Every fixture must be consumed.
 *
 * Usage
 *   pnpm run check:api-examples
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const pageFile = "api-reference/endpoints.mdx";
const fixturesFile = "scripts/fixtures/api-endpoint-responses.json";
const moduleFile = "endpoints.ts";
const apiOrigin = "https://api.wraith.dev";
const testApiKey = "wraith_test_docs_examples";

const typescriptLanguages = new Set(["ts", "typescript"]);
const routePattern = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/;
const fixtureTypePattern = /^[A-Za-z_][A-Za-z0-9_]*(\[\])?$/;

type Fence = {
  lang: string;
  attrs: string;
  code: string;
  /** 1-based MDX line of the first line inside the fence. */
  line: number;
};

type Route = {
  method: string;
  path: string;
  regex: RegExp;
};

type Fixture = {
  request: string;
  status: number;
  type: string;
  body: unknown;
};

type Segment = {
  /** First generated line (1-based) covered by this segment. */
  start: number;
  /** Last generated line (1-based) covered by this segment. */
  end: number;
  describe: (generatedLine: number, column: string) => string;
};

type GeneratedModule = {
  source: string;
  segments: Segment[];
};

async function main() {
  const markdown = await readFile(path.join(repoRoot, pageFile), "utf8");
  const fences = parseFences(markdown);
  const examples = fences.filter((fence) => typescriptLanguages.has(fence.lang));
  const routes = fences.flatMap((fence) => parseRoute(fence) ?? []);
  const fixtures = parseFixtures(await readFile(path.join(repoRoot, fixturesFile), "utf8"));
  const errors: string[] = [];

  for (const fence of fences) {
    if (/\bno-check\b/.test(fence.attrs)) {
      errors.push(
        `${pageFile}:${fence.line - 1}: remove \`no-check\`. Every fence on this page is ` +
          "type-checked; use a fence without a language for prose fragments.",
      );
    }
  }
  if (examples.length === 0) {
    errors.push(`${pageFile}: no TypeScript fences found.`);
  }
  if (routes.length === 0) {
    errors.push(`${pageFile}: no documented routes (\`METHOD /path\` fences) found.`);
  }
  for (const fixture of fixtures) {
    const [method, requestPath] = fixture.request.split(" ");
    if (!routes.some((route) => route.method === method && route.regex.test(requestPath))) {
      errors.push(
        `${fixturesFile}: "${fixture.request}" does not match a route documented on ${pageFile}.`,
      );
    }
  }
  if (errors.length > 0) fail(errors);

  const generated = renderModule(examples, fixtures);
  const tmp = await mkdtemp(path.join(tmpdir(), "wraith-api-examples-"));
  let outcome: { errors: string[]; output: string[]; requests: string[] };

  try {
    await writeFile(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    await symlink(path.join(repoRoot, "node_modules"), path.join(tmp, "node_modules"), "dir");
    await writeFile(path.join(tmp, moduleFile), generated.source, "utf8");
    await writeFile(
      path.join(tmp, "tsconfig.json"),
      JSON.stringify(createTsConfig(), null, 2),
      "utf8",
    );

    const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    const typecheck = await run(
      process.execPath,
      [tsc, "--project", "tsconfig.json", "--pretty", "false"],
      tmp,
    );

    if (typecheck.exitCode !== 0) {
      const report = mapLocations(typecheck.output.trim(), generated.segments);
      outcome = { errors: [`Type check failed:\n\n${report}`], output: [], requests: [] };
    } else {
      const result = await runExamples(path.join(tmp, moduleFile), routes, fixtures);
      outcome = {
        ...result,
        errors: result.errors.map((error) => mapLocations(error, generated.segments)),
      };
    }
  } finally {
    await rm(tmp, { force: true, recursive: true });
  }

  if (outcome.errors.length > 0) fail(outcome.errors, outcome.output);

  console.log(
    [
      `Page: ${pageFile}`,
      `Documented routes: ${routes.length}`,
      `TypeScript fences compiled (strict): ${examples.length}`,
      `Typed response fixtures: ${fixtures.length}`,
      `Requests served: ${outcome.requests.length}`,
      "",
      "Example output:",
      ...outcome.output.map((line) => `  ${line}`),
      "",
      "API example check passed.",
    ].join("\n"),
  );
}

/** Collects fenced code blocks, including fences without a language. */
function parseFences(markdown: string): Fence[] {
  const fences: Fence[] = [];
  const lines = markdown.split("\n");
  let open: { lang: string; attrs: string; line: number; body: string[] } | null = null;

  lines.forEach((line, index) => {
    if (open === null) {
      const match = /^```([A-Za-z0-9_-]*)(.*)$/.exec(line);
      if (match) {
        open = { lang: match[1].toLowerCase(), attrs: match[2].trim(), line: index + 2, body: [] };
      }
      return;
    }
    if (line.trim() === "```") {
      fences.push({
        lang: open.lang,
        attrs: open.attrs,
        code: open.body.join("\n"),
        line: open.line,
      });
      open = null;
      return;
    }
    open.body.push(line);
  });

  return fences;
}

/** Reads a route fence such as `GET /agent/:id/status`. */
function parseRoute(fence: Fence): Route | null {
  if (fence.lang !== "") return null;
  const match = routePattern.exec(fence.code.trim());
  if (!match) return null;

  const [, method, routePath] = match;
  const source = routePath
    .split("/")
    .map((part) => (part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return { method, path: routePath, regex: new RegExp(`^${source}$`) };
}

function parseFixtures(json: string): Fixture[] {
  const parsed = JSON.parse(json) as { responses?: unknown };
  if (!Array.isArray(parsed.responses)) {
    fail([`${fixturesFile}: expected a "responses" array.`]);
  }

  return parsed.responses.map((entry, index) => {
    const fixture = entry as Partial<Fixture>;
    const where = `${fixturesFile} responses[${index}]`;
    if (typeof fixture.request !== "string" || !/^[A-Z]+ \/\S*$/.test(fixture.request)) {
      fail([`${where}: "request" must look like "GET /path".`]);
    }
    if (typeof fixture.status !== "number" || !Number.isInteger(fixture.status)) {
      fail([`${where}: "status" must be an integer HTTP status.`]);
    }
    if (typeof fixture.type !== "string" || !fixtureTypePattern.test(fixture.type)) {
      fail([`${where}: "type" must name a page type, e.g. "AgentInfo" or "Message[]".`]);
    }
    if (!("body" in fixture)) {
      fail([`${where}: "body" is required.`]);
    }
    return fixture as Fixture;
  });
}

/**
 * Renders the page's TypeScript fences into one module, followed by a
 * `satisfies` assertion per fixture, and records where each line came from.
 */
function renderModule(examples: Fence[], fixtures: Fixture[]): GeneratedModule {
  const lines = [
    `// Generated by scripts/check-api-examples.ts from ${pageFile} and ${fixturesFile}.`,
  ];
  const segments: Segment[] = [];

  for (const fence of examples) {
    lines.push(`// ${pageFile}:${fence.line}`);
    const start = lines.length + 1;
    lines.push(...fence.code.split("\n"));
    segments.push({
      start,
      end: lines.length,
      describe: (generatedLine, column) =>
        `${pageFile}:${fence.line + generatedLine - start}:${column}`,
    });
  }

  lines.push("", "export {};", "", `// Typed network fixtures from ${fixturesFile}.`);
  fixtures.forEach((fixture, index) => {
    const start = lines.length + 1;
    const body = JSON.stringify(fixture.body, null, 2).split("\n");
    body[0] = `const fixture${index} = ${body[0]}`;
    body[body.length - 1] = `${body[body.length - 1]} satisfies ${fixture.type};`;
    lines.push(...body);
    segments.push({
      start,
      end: lines.length,
      describe: () => `${fixturesFile} responses[${index}] (${fixture.request} as ${fixture.type})`,
    });
  });

  return { source: `${lines.join("\n")}\n`, segments };
}

function createTsConfig() {
  return {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022"],
      types: ["node"],
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      noEmit: true,
    },
    files: [moduleFile],
  };
}

async function runExamples(modulePath: string, routes: Route[], fixtures: Fixture[]) {
  const errors: string[] = [];
  const output: string[] = [];
  const requests: string[] = [];
  const used = new Set<number>();

  const fixtureFetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = (init.method ?? "GET").toUpperCase();
    const request = `${method} ${url.pathname}`;
    requests.push(request);

    if (url.origin !== apiOrigin) {
      throw new Error(`${request}: sent to ${url.origin}, expected ${apiOrigin}.`);
    }
    if (url.search !== "") {
      throw new Error(`${request}: unexpected query string ${url.search}.`);
    }
    if (!routes.some((route) => route.method === method && route.regex.test(url.pathname))) {
      throw new Error(`${request}: not a route documented on ${pageFile}.`);
    }

    const headers = new Headers(init.headers);
    if (headers.get("authorization") !== `Bearer ${testApiKey}`) {
      throw new Error(`${request}: missing the "Authorization: Bearer <api key>" header.`);
    }
    if (init.body !== undefined && init.body !== null) {
      if (headers.get("content-type") !== "application/json") {
        throw new Error(`${request}: JSON bodies need "Content-Type: application/json".`);
      }
      try {
        JSON.parse(String(init.body));
      } catch {
        throw new Error(`${request}: request body is not valid JSON.`);
      }
    }

    const index = fixtures.findIndex(
      (fixture, candidate) => !used.has(candidate) && fixture.request === request,
    );
    if (index === -1) {
      throw new Error(`${request}: no unused fixture in ${fixturesFile}.`);
    }
    used.add(index);

    const fixture = fixtures[index];
    return new Response(JSON.stringify(fixture.body), {
      status: fixture.status,
      headers: { "content-type": "application/json" },
    });
  };

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalApiKey = process.env.WRAITH_API_KEY;

  globalThis.fetch = fixtureFetch as typeof fetch;
  console.log = (...args: unknown[]) => {
    output.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  process.env.WRAITH_API_KEY = testApiKey;

  try {
    await import(pathToFileURL(modulePath).href);
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    errors.push(`Running the examples failed:\n\n${detail}`);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) {
      delete process.env.WRAITH_API_KEY;
    } else {
      process.env.WRAITH_API_KEY = originalApiKey;
    }
  }

  if (errors.length === 0) {
    fixtures.forEach((fixture, index) => {
      if (!used.has(index)) {
        errors.push(
          `${fixturesFile} responses[${index}] (${fixture.request}) was never requested.`,
        );
      }
    });
  }

  return { errors, output, requests };
}

/** Rewrites `endpoints.ts(12,5)` and `endpoints.ts:12:5` to their MDX or fixture source. */
function mapLocations(text: string, segments: Segment[]) {
  const describe = (line: number, column: string) => {
    const segment = segments.find((candidate) => line >= candidate.start && line <= candidate.end);
    return segment ? segment.describe(line, column) : `${moduleFile}:${line}:${column}`;
  };

  return text
    .replace(/(?:[^\s(]*[\\/])?endpoints\.ts\((\d+),(\d+)\)/g, (_, line, column) =>
      describe(Number(line), column),
    )
    .replace(/(?:file:\/\/)?(?:[^\s(]*[\\/])?endpoints\.ts:(\d+):(\d+)/g, (_, line, column) =>
      describe(Number(line), column),
    );
}

function run(command: string, args: string[], cwd: string) {
  return new Promise<{ exitCode: number; output: string }>((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env, shell: false });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, output });
    });
  });
}

function fail(errors: string[], output: string[] = []): never {
  const details =
    output.length > 0
      ? `\n\nExample output before the failure:\n${output.map((line) => `  ${line}`).join("\n")}`
      : "";
  console.error(`API example check failed:\n\n${errors.join("\n\n")}${details}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
