# Channel Sync (SyncChannel)

Standalone Emby plugin — Radarr "Coming Soon" channel integration, split out
of ManageComingSoon. Self-contained: no reference to, or dependency on, the
ManageComingSoon project.

## Before this builds

Two binary assets are referenced by the `.csproj` but weren't part of the
chat transcript this project was generated from, so they're not included
here. Copy them over from the ManageComingSoon project root — same files,
reused as-is:

- `thumb.png`  → place at `SyncChannel/thumb.png`
- `comingsoon.mp4` → place at `SyncChannel/comingsoon.mp4`

Both are wrapped in `Condition="Exists(...)"` in the `.csproj`, so the
project still builds without them — but the channel will have no thumbnail
and no default placeholder video until they're added (`GetThumbImage` falls
back to `Stream.Null`; the stub-resolution path logs a Warn and returns no
playable source).

## What changed vs. the ManageComingSoon original

- **New GUID** (`6b2e4f17-9a3c-4d8b-8e1f-2c7a5b9d3e60`) — unrelated to
  ManageComingSoon's plugin ID as far as Emby's registry is concerned.
- **New data folder**: `IApplicationPaths.DataPath/channel-sync/` instead of
  `manage-coming-soon/`. This was a deliberate choice (confirmed with the
  operator) over reusing the old folder — it means a clean split with no
  shared mutable state between the two plugins, at the cost of the Radarr
  rule set reseeding to its default on first run rather than carrying over
  automatically. If you want to keep an existing custom rule set, open the
  Rules page after first install and rebuild it, or manually copy
  `manage-coming-soon/radarr-rulesets.json` to
  `channel-sync/radarr-rulesets.json` before first startup.
- **API routes** moved from `/ManageComingSoon/Radarr*` to
  `/ChannelSync/Radarr*` (`RadarrRulesApiSurface.cs`); `rulesPage.js` was
  updated to match.
- **No tab UI** — ManageComingSoon's `MainPageController` implements
  `IHasTabbedUIPages` for its three tabs (Add Movie / Make Live /
  Configuration). This plugin only ever had one settings surface, so
  `MainPageController` here is a single `IsMainConfigPage` page with no tab
  machinery at all.
- **`TmdbService` dependency dropped** from `RadarrComingSoonChannel` — it
  was only used by a commented-out, never-enabled poster-fallback path.
  Carrying that dependency into a standalone plugin would mean pulling in a
  whole extra HTTP service for dead code.
- **`RadarrChannelIdentityReconciler` kept its Radarr-prefixed name** for
  this pass (per the operator's explicit choice) even though nothing in its
  body is actually Radarr-specific. Worth revisiting when a second source
  (e.g. Sonarr) is added and the class needs to be shared.
- Log line prefix changed from `"ManageComingSoon: "` to `"ChannelSync: "`
  throughout.

## Adding to a solution

No `.slnx`/`.sln` is included — add this project to whichever solution you're
using, or create a fresh one:

```
dotnet new sln -n SyncChannel
dotnet sln add SyncChannel.csproj
```

## Not carried over (left in ManageComingSoon by design)

Nothing outside the Radarr/Rules feature set — TMDB search, Add Coming Soon,
Make Live, the placeholder-video "Coming Soon" library workflow, and the
generic `ComingSoonEntryPoint` tagging logic all remain exactly where they
are. This plugin only knows about the Radarr channel and its rules.
