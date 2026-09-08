# @macarons/usage-limits

Provider-neutral contracts and a headless TUI engine shared by the limits
plugins in Macarons.

The library owns quota snapshot shapes, quota-time formatting, provider relevance,
authentication synchronization, polling, classifier relevance, and lifecycle
cleanup. Provider-specific authentication and API parsing stay in each plugin.
JSX and runtime Solid imports also stay in each plugin's `src/tui.tsx`: OpenCode
substitutes its Solid runtime only for the entry module, so moving rendering or
signal creation behind a normal library import would create a second,
non-reactive Solid graph.

The engine never reads the TUI's environment or home for provider credentials:
loopback and matching path strings do not establish a server auth scope. A
provider needing stored OAuth must supply a server-verified reader, as Codex
does through its server companion. Server-resolved provider keys remain
available through `ProviderContext.provider`, including for Synthetic attaches.
