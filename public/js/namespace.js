/**
 * namespace.js — per-key data isolation. Different OpenAI API keys get
 * separate board / log / usage / settings, so the same browser behaves like
 * multiple independent accounts.
 *
 * Namespace is derived from the trailing 12 chars of the OpenAI key. Without
 * a key, "default" is used.
 */

const SUBSCRIBERS = new Set();

export function getNamespace() {
  const k = localStorage.getItem("openai_api_key") || "";
  if (!k) return "default";
  const tail = k.slice(-12).replace(/[^a-zA-Z0-9_-]/g, "_");
  return tail || "default";
}

export function namespaced(baseKey) {
  return `${baseKey}__${getNamespace()}`;
}

export function onNamespaceChange(fn) {
  SUBSCRIBERS.add(fn);
  return () => SUBSCRIBERS.delete(fn);
}

export function emitNamespaceChange() {
  for (const fn of SUBSCRIBERS) {
    try { fn(getNamespace()); } catch (err) { console.error("[namespace] subscriber failed", err); }
  }
}
