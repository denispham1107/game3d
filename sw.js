"use strict";

const GAME_BUILD_VERSION = "20260904-1e15528b72a1";
const CACHE_PREFIX = "phuthuy3d-shell-";
const LEGACY_CACHE_PREFIXES = ["diablo25d-shell-"];
const SHELL_CACHE = `${CACHE_PREFIX}${GAME_BUILD_VERSION}`;
const APP_SHELL = [
  "./", "./index.html", "./manifest.webmanifest",
  "./styles/game-shell.css", "./TemplateData/style.css",
  "./TemplateData/progress-bar-empty-dark.png", "./TemplateData/progress-bar-full-dark.png",
  "./TemplateData/fullscreen-button.png", "./icons/icon-192.png", "./icons/icon-512.png",
  "./icons/icon-512-maskable.png", "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => (
      name.startsWith(CACHE_PREFIX) || LEGACY_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) && name !== SHELL_CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response.ok) await cache.put("./index.html", response.clone());
    return response;
  } catch {
    return (await cache.match(request)) || (await cache.match("./index.html")) || Response.error();
  }
}

async function shellAsset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const refresh = fetch(request, { cache: "no-cache" })
    .then(async (response) => {
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached || Response.error());
  return cached || refresh;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
  // Unity owns revalidation of its large data file; avoiding a second cache
  // prevents duplicate storage and stale cross-version asset combinations.
  if (url.pathname.includes("/Build/") || url.pathname.includes("/StreamingAssets/")) {
    event.respondWith(fetch(request, { cache: "no-store" }));
    return;
  }
  event.respondWith(shellAsset(request).catch(() => caches.match(request, { ignoreSearch: true })));
});
