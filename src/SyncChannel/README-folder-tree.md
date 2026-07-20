# Folder Tree Channel — new files

This is the full architecture discussed in chat, implemented as a **new,
additive** set of files. Nothing in the existing repo is modified except
two files noted below — the existing flat `RadarrComingSoonChannel` /
`RadarrChannelSyncTask` / Rules editor keep working completely unchanged.

## Where each file goes (paths relative to `src/SyncChannel/`)

```
Fetching/IFetchProvider.cs              (new)
Fetching/FetchProviderRegistry.cs       (new)
Fetching/RadarrFetchProvider.cs         (new)
Configuration/FolderTree.cs             (new)
Configuration/FolderTreeStore.cs        (new)
Models/FolderCache.cs                   (new)
Services/FolderCacheStore.cs            (new)
Channels/SyncFolderChannel.cs           (new)
ScheduledTasks/FolderTreeSyncTask.cs    (new)
Rules/FolderTreeApiSurface.cs           (new)
Rules/WebUI/folderTreePage.html         (new)
Rules/WebUI/folderTreePage.js           (new)
SyncChannelPlugin.cs                    (REPLACES existing file)
SyncChannel.csproj                      (REPLACES existing file)
```

`SyncChannelPlugin.cs` and `SyncChannel.csproj` are full replacements —
diffed against the versions in your last "tidy" push, the only changes are:
registering the two new `folderTreePage.html/.js` pages in `GetPages()`,
bumping the package version, and adding the two new `EmbeddedResource`
entries. Nothing else in either file changed.

## What this gives you

- A separate `IChannel` — **"Coming Soon"** — distinct from the existing
  Radarr channel, browsable as an arbitrary-depth admin-defined folder tree.
- Each folder (including the root) can hold zero or more **fetches**, each
  naming a provider (`radarr` is the only one wired up right now) and that
  provider's own settings (URL/API key/rule set for Radarr).
- A new scheduled task, **"Sync Coming Soon Folder Tree"**, walks the tree
  and writes one cache file per folder.
- A new admin page, **"Coming Soon Folder Tree"** (main menu, same as the
  existing Rules page), for building/editing the tree.

## Before this builds

1. Copy all files above into their listed paths.
2. `thumb.png` / `comingsoon.mp4` — same as the existing README notes,
   unchanged requirement, nothing new needed here.
3. No new NuGet packages required — everything new uses only what's already
   referenced (`System.Text.Json`, `MediaBrowser.Server.Core`).

## Deliberately left as follow-up work, not guessed at

- **`ChannelFolderType` beyond `Container`** — `Series`/`Season`/`PhotoAlbum`
  aren't used; every admin-created folder is a plain `Container`. Fine for
  movies; if a Sonarr-driven "Series" folder type is wanted later (so Emby
  treats it as an actual Series entity rather than a generic folder), that's
  a deliberate, separate decision — not something to default into silently.
- **`IHasChannelFeatures`** — not implemented, matching the confirmed
  conclusion in chat that it isn't needed for "root always visible,
  subfolders nested underneath."
- **Per-provider stub video override** — `SyncFolderChannel` falls back to
  one shared default stub (same file, re-extracted from the embedded
  resource) for every folder. The existing channel's custom-stub-video
  config setting was not carried over to the folder tree; every folder plays
  the same default stub until that's explicitly wanted otherwise.
- **A "Manage Coming Soon Folder Tree" link inside the existing GenericEdit
  config page** (mirroring `RadarrRulesLink`) — not added. The new page is
  reachable via the main menu (`EnableInMainMenu = true`, same mechanism as
  the existing Rules page), so it's discoverable without this, but a
  same-page link would be a small, easy follow-up if wanted.
- **Sonarr provider** — the registry/UI is fully ready for it
  (`FetchProviderRegistry`'s constructor gets one more named parameter,
  `GetFetchProviders` picks it up automatically, the admin UI's "Add Fetch"
  provider picker and field-schema rendering need zero changes) but no
  `SonarrFetchProvider` is implemented here — there's no existing working
  Sonarr integration in this repo to wrap the way `RadarrFetchProvider`
  wraps the confirmed-working Radarr logic.

## One thing to verify on your end before relying on this in production

`FetchProviderRegistry`'s constructor takes `RadarrFetchProvider` as a named
concrete parameter — the same DI shape already confirmed working for
`RadarrClient`'s dependency chain into the auto-discovered
`RadarrComingSoonChannel`. I'm confident in that pattern from what's in
`Evidence.md`, but this whole new dependency chain (`FolderTreeSyncTask` /
`FolderTreeApiSurface` / `SyncFolderChannel` all pulling in
`FetchProviderRegistry` → `RadarrFetchProvider` → `RadarrRuleSetStore`) has
not actually been run against a live server. Worth a first real build/deploy
pass, watching the server log at startup for any container-resolution
errors, before treating this as confirmed the way the rest of `Evidence.md`
is — and worth logging whatever you find back into `Evidence.md` either way.
