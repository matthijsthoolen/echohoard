import { ECHOHOARD_VERSION } from "../../application/version";
import { getErrorDescriptor, type ErrorKind } from "./error-registry";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

export function renderErrorDocument(kind: ErrorKind): string {
  const descriptor = getErrorDescriptor(kind);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(descriptor.title)} · EchoHoard</title>
    <style>
      :root{color-scheme:light;--canvas:#f5f7fa;--surface:#fff;--ink:#17212b;--muted:#5b6875;--line:#d7dee7;--accent:#075e67;--soft:#d7f1f0}
      *{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--canvas);color:var(--ink);font:16px/1.5 Inter,ui-sans-serif,system-ui,sans-serif}
      main{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(18rem,.9fr);align-items:center;gap:clamp(1.5rem,5vw,5rem);width:min(100%,72rem);min-height:100vh;margin:auto;padding:clamp(1.5rem,6vw,5rem)}
      img{display:block;width:100%;max-height:34rem;object-fit:contain}.copy{max-width:34rem}.code{color:var(--accent);font-size:.8rem;font-weight:800;letter-spacing:.1em}.copy h1{margin:.5rem 0 1rem;font-size:clamp(2rem,5vw,4rem);line-height:1.05;letter-spacing:-.04em}.copy p{color:var(--muted);font-size:1.08rem}.action{display:inline-flex;align-items:center;min-height:2.75rem;padding:.6rem 1rem;border:1px solid var(--accent);border-radius:.75rem;background:var(--accent);color:#fff;font-weight:750;text-decoration:none}.version{margin-top:2rem;color:var(--muted);font-size:.72rem;letter-spacing:.04em}
      @media(max-width:720px){main{grid-template-columns:1fr;gap:1rem;min-height:100vh;padding:1.5rem}.copy{order:1}img{order:0;max-height:19rem}.copy h1{font-size:clamp(2rem,10vw,3rem)}}
      @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
    </style>
  </head>
  <body><main><img src="${escapeHtml(descriptor.image)}" alt="${escapeHtml(descriptor.imageAlt)}"><section class="copy" aria-labelledby="error-title"><div class="code">${escapeHtml(descriptor.code || "ERROR")}</div><h1 id="error-title">${escapeHtml(descriptor.title)}</h1><p>${escapeHtml(descriptor.description)}</p><a class="action" href="${escapeHtml(descriptor.primaryAction.href)}">${escapeHtml(descriptor.primaryAction.label)}</a><div class="version">v${escapeHtml(ECHOHOARD_VERSION)}</div></section></main></body>
</html>`;
}
