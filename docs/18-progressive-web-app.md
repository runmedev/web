---
name: progressive-web-app
title: Progressive Web App And Offline Loading
order: 18
description: >-
  Use this guide to install Runme Web as a Progressive Web App or understand
  what remains available after the browser goes offline. It covers the app
  manifest, service-worker update behavior, cached app-shell resources, local
  notebook persistence, and the network-backed features that still require a
  connection.
---

# Progressive Web App And Offline Loading

Runme Web is installable as a Progressive Web App (PWA) in browsers that
support installation. After one successful online load, its application shell
is cached so the installed app and normal browser tab can open without a
network connection.

## Install Runme Web

1. Open the deployed Runme Web URL in a supported browser.
2. Wait for the application to finish loading once while online.
3. Use the browser's **Install app** action. Depending on the browser, this can
   appear in the address bar or application menu.

The installed app opens in its own standalone window. Runme does not show a
separate in-app install prompt; installation remains under browser control.

## What works offline

The service worker caches the HTML entry point, content-hashed JavaScript and
CSS bundles, application icons, the web app manifest, and the default runtime
configuration. Navigation URLs such as `/?session=...` and `/?doc=...` fall
back to the cached application shell when the network is unavailable.

Browser-local notebooks and already-loaded notebook data remain in browser
storage. Runme requests persistent browser storage, but the browser ultimately
decides whether to grant and retain it.

## What still requires a network connection

Offline loading does not make remote services local. These features still need
connectivity:

- Google Drive authorization, search, opening uncached Drive files, and sync
- OIDC sign-in and token refresh
- remote Runme runners, agents, Jupyter servers, and other backend APIs
- documentation or external resources that have not already been cached

Edits to a previously opened Drive-backed notebook can remain local while
offline and synchronize after connectivity and authorization recover. Check
the Drive sync status before assuming remote persistence is complete.

## Updates

Each production build emits a service worker with the exact hashed assets for
that build. A newly downloaded service worker waits until the previous version
is no longer in use, then activates and removes superseded Runme caches. Reload
or reopen the app after a deployment to begin using the new version.

The development server does not register the service worker. Use a production
build with `pnpm -C app run preview` when testing installation or offline
behavior locally.
