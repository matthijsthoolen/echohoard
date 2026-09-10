import { spawn } from "node:child_process";

const port = Number(process.env.ECHOHOARD_VIEWER_PORT ?? 4318);
const baseUrl = process.env.ECHOHOARD_VIEWER_BASE_URL ?? `http://127.0.0.1:${port}`;
const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const targets = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "iu"));
  return match?.[1];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function runAccessibilityAudit(html, target) {
  assert(
    (html.match(/<main\b/gu) ?? []).length === 1,
    `${target.name}: expected one main landmark`,
  );
  assert(
    html.includes('aria-label="Primary navigation"'),
    `${target.name}: primary nav is unlabeled`,
  );
  assert(
    html.includes('aria-label="Conversation navigation"'),
    `${target.name}: conversation nav is unlabeled`,
  );
  assert(html.includes('href="#main-content"'), `${target.name}: skip link is missing`);
  assert(html.includes('id="main-content"'), `${target.name}: skip target is missing`);
  assert(
    !/<(?:a|button|input|select|textarea)\b[^>]*\btabindex\s*=\s*["'](?:[1-9]|[1-9][0-9]+)["']/iu.test(
      html,
    ),
    `${target.name}: positive tabindex found`,
  );

  const headings = [...html.matchAll(/<h([1-6])\b/gu)].map((match) => Number(match[1]));
  assert(headings[0] === 1, `${target.name}: document must start with an h1`);
  for (let index = 1; index < headings.length; index += 1)
    assert(
      headings[index] <= headings[index - 1] + 1,
      `${target.name}: heading level skips from h${headings[index - 1]} to h${headings[index]}`,
    );

  const interactive = [...html.matchAll(/<(a|button|input|select|textarea)\b[^>]*>/giu)];
  for (const match of interactive) {
    const tag = match[0];
    const kind = match[1].toLowerCase();
    if (kind === "a") assert(attribute(tag, "href"), `${target.name}: link has no href`);
    if (kind === "input" || kind === "select" || kind === "textarea") {
      const label = attribute(tag, "aria-label");
      const id = attribute(tag, "id");
      const nestedLabel = new RegExp(
        `<label\\b[^>]*>[\\s\\S]{0,400}${escapeRegex(tag)}`,
        "iu",
      ).test(html);
      assert(label || id || nestedLabel, `${target.name}: form control has no label or id`);
    }
  }
}

async function fetchPage(path, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  return { response, body: await response.text() };
}

async function waitForApp() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // Keep polling until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("viewer production app did not become ready");
}

async function runAuthenticatedWorkflow() {
  const cookie = process.env.ECHOHOARD_VIEWER_SESSION_COOKIE;
  if (!cookie) {
    console.log(
      "Authenticated workflow: skipped (set ECHOHOARD_VIEWER_SESSION_COOKIE for live acceptance)",
    );
    return;
  }
  const headers = { Cookie: cookie, Accept: "application/json" };
  const conversations = await fetchPage("/api/conversations?limit=50", headers);
  assert(
    conversations.response.status === 200,
    `authenticated conversation browse returned ${conversations.response.status}`,
  );
  const body = JSON.parse(conversations.body);
  assert(
    Array.isArray(body.items) && body.items.length <= 50,
    "conversation page exceeded its bound",
  );
  const conversationId = body.items[0]?.id;
  if (typeof conversationId === "string") {
    const messages = await fetchPage(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=50&direction=backward`,
      headers,
    );
    assert(
      messages.response.status === 200,
      `authenticated history browse returned ${messages.response.status}`,
    );
    const page = JSON.parse(messages.body);
    assert(Array.isArray(page.items) && page.items.length <= 50, "message page exceeded its bound");
    const newer = await fetchPage(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=50&direction=forward`,
      headers,
    );
    assert(
      newer.response.status === 200,
      `bidirectional history returned ${newer.response.status}`,
    );
  }
  const search = await fetchPage("/api/search?q=synthetic&limit=50", headers);
  assert(search.response.status === 200, `search workflow returned ${search.response.status}`);
  assert(JSON.parse(search.body).items.length <= 50, "search page exceeded its bound");
  console.log("Authenticated workflow: browse, bidirectional history, and search passed");
}

let server;
try {
  if (!process.env.ECHOHOARD_VIEWER_BASE_URL) {
    const build = await run(["build:web"]);
    assert(build.code === 0, `production build failed\n${build.output}`);
    server = spawn(command, ["exec", "next", "start", "src/delivery/web", "-p", String(port)], {
      stdio: "ignore",
    });
    await waitForApp();
  }
  for (const target of targets) {
    const { response, body } = await fetchPage("/", {
      Accept: "text/html",
      "X-EchoHoard-Test-Viewport": `${target.width}x${target.height}`,
    });
    assert(response.status === 200, `${target.name}: home page returned ${response.status}`);
    runAccessibilityAudit(body, target);
  }
  const pageSource = await fetchPage("/");
  const stylesheets = [
    ...pageSource.body.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/giu),
  ].map((match) => match[1]);
  assert(stylesheets.length > 0, "responsive page has no stylesheet");
  const css = (
    await Promise.all(
      stylesheets.map(async (href) =>
        fetch(`${baseUrl}${href}`).then((response) => response.text()),
      ),
    )
  ).join("\n");
  assert(css.includes(":focus-visible"), "responsive stylesheet missing :focus-visible");
  assert(
    /@media\s*\(\s*max-width\s*:\s*719px\s*\)/u.test(css),
    "responsive stylesheet missing mobile media query",
  );
  assert(css.includes(".mobile-nav"), "responsive stylesheet missing .mobile-nav");
  for (const path of [
    "/api/conversations",
    "/api/search?q=synthetic",
    "/api/media/synthetic-attachment",
  ]) {
    const { response } = await fetchPage(path);
    assert(response.status === 401, `anonymous ${path} returned ${response.status}`);
  }
  await runAuthenticatedWorkflow();
  console.log(
    "Viewer acceptance seam passed: accessibility, target-width shell, and auth boundaries",
  );
} catch (error) {
  console.error(`Viewer acceptance seam failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (server) server.kill("SIGTERM");
}
