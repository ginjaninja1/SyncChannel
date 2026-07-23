version 2.1

Design: Auto-generated collage thumbnails for Channel Sync folder-tree subfolders
Background / why this is needed
Confirmed via ILSpy investigation (this session) that Emby's built-in folder-collage generation (CollectionFolderImageProvider : BaseCollageImageProvider) is gated by:
csharppublic override bool Supports(BaseItem item)
{
    if (item is ICollectionFolder collectionFolder) { ... }
    return false;
}
A channel-tree FolderNode is persisted as a plain Folder BaseItem (FolderType = Container), not an ICollectionFolder (library roots, box sets, playlists only). So Emby's inbuilt provider pipeline will never generate a poster for these folders — confirmed structurally unreachable, not a config/refresh gap. (ChannelImageProvider was also checked and ruled out — it only applies to the Channel BaseItem itself, Supports => item is Channel.)
However, the actual compositing primitive Emby uses internally is a generic, ungated utility method:
csharp// MediaBrowser.Controller.Drawing.IImageProcessor
Task CreateImageCollage(ImageCollageOptions options, CancellationToken cancellationToken);
csharppublic sealed class ImageCollageOptions
{
    public ItemImageInfo[] Images { get; set; }   // local file paths, wrapped
    public string OutputPath { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
}
This can be called directly from our own plugin code, bypassing the ICollectionFolder gate entirely. IImageProcessor is already injected elsewhere in this codebase (ChannelIdentityReconciler), so no new DI wiring is needed for that dependency.
Requirements (per operator discussion)

Collage should be built from the 4 most recently added items in the folder (movies/shows, from that folder's FolderCache.Items), not an arbitrary/random 4.
If fewer than 4 items are available, pad/duplicate to reach 4 (assumption pending encoder-behavior verification — see Open Verification Item below; write defensive code regardless).
First instantiation (folder currently has no Primary image): always attempt to build a collage, once ≥1 item is available (ideally ≥4, but don't block indefinitely on that — same "best effort" pattern as ReapplyChannelImage's HasImage guard).
After that, only rebuild when a new per-folder config toggle "Replace image on change" is enabled, and the folder's top-4-most-recent set has actually changed since last build.
This must not run on every 15-minute sync tick regardless of change — needs explicit change detection.

New data needed
1. Track "recently added" per cached item
CachedChannelItem (Models/FolderCache.cs) currently has no concept of when an item first appeared in this plugin's tracking. Radarr/Sonarr's own API payload doesn't reliably give us "date added to Radarr" in a form already piped through (and even if it did, "recently added to Radarr" and "recently added to this folder's cache" could differ — a rule-set change could suddenly surface an older Radarr item as newly-matching here).
Add a field:
csharppublic class CachedChannelItem
{
    // ...existing fields...
    public DateTimeOffset FirstSeenUtc { get; set; }
}
Populate this in FolderTreeSyncTask.ToCache(...): when merging mergedItems, if the StableId already existed in existingCache.Items, carry forward its original FirstSeenUtc; only set it to DateTimeOffset.UtcNow for genuinely new StableIds. This requires ToCache (currently a static method taking just FetchedItem + fetchInstanceId) to also take a lookup of prior items by StableId — a small signature change in SyncSingleNode.
2. Per-folder "replace image on change" toggle
Add to FolderNode (Configuration/FolderTree.cs):
csharppublic bool ReplaceImageOnContentChange { get; set; } = true; // or false — pick a sensible default with the operator
Surface this as a checkbox in manageComingSoonPage.html/.js's folder-tree node UI (buildFolderNode in the JS — alongside the existing name/remove controls).
3. Change detection — what was the collage last built from
Add to FolderCache (Models/FolderCache.cs):
csharppublic List<string> LastCollageStableIds { get; set; } = new List<string>();
Compare the newly-computed top-4-most-recent StableId list against this each sync; only rebuild if different (or if no Primary image exists yet at all — first-instantiation case). Update this field whenever a collage build actually happens.
New helper needed: poster download-to-disk
Nothing existing downloads arbitrary binary content — HttpFetchProvider only does JSON-returning GETs via IHttpClient. ImageCollageOptions.Images requires local file paths wrapped as ItemImageInfo, not remote URLs.
Add a small method (new class, e.g. Services/FolderCollageBuilder.cs, or a method on HttpFetchProvider — recommend a new dedicated class since this is compositing/image logic, not fetch logic):
csharpprivate async Task<string> DownloadPosterToCache(string posterUrl, string cacheKey, CancellationToken ct)
{
    var path = Path.Combine(appPaths.DataPath, "channel-sync", "folder-thumbs", cacheKey + ".jpg");
    // if already exists and this StableId+PosterUrl combo unchanged, skip re-download — cache by StableId
    // else: httpClient.GetResponse(new HttpRequestOptions { Url = posterUrl, CancellationToken = ct })
    //       write response.Content stream to `path`
    return path;
}
Cache these persistently keyed by StableId (not by folder — the same movie could appear in multiple folders) so re-syncs don't re-download unchanged posters repeatedly.
Core new logic: FolderCollageBuilder (or similar name)
csharppublic class FolderCollageBuilder
{
    // Constructor deps: IImageProcessor, IHttpClient, ILibraryManager, IApplicationPaths, ILogger

    public async Task BuildIfNeeded(FolderNode node, FolderCache cache, CancellationToken ct)
    {
        // 1. Find the folder's BaseItem via ExternalId — confirmed field on InternalItemsQuery:
        var query = new InternalItemsQuery { ExternalId = SyncFolderChannel.BuildFolderItemId(node.Id) };
        var folderItem = libraryManager.GetItemsResult(query).Items.FirstOrDefault();
        if (folderItem == null)
        {
            logger.Warn("ChannelSync: Folder BaseItem for '{0}' not found yet — skipping collage build this run.", node.DisplayName);
            return; // expected on first sync before Emby persists the folder — same tolerance as ChannelIdentityReconciler
        }

        bool hasImage = folderItem.HasImage(ImageType.Primary);

        // 2. Compute top-4 most-recently-added StableIds
        var top4 = cache.Items
            .OrderByDescending(i => i.FirstSeenUtc)
            .Take(4)
            .ToList();

        if (top4.Count == 0) return; // nothing to build from yet

        // 3. Gate: only (re)build if no image yet, OR (ReplaceImageOnContentChange && set changed)
        var newIds = top4.Select(i => i.StableId).ToList();
        bool setChanged = !newIds.SequenceEqual(cache.LastCollageStableIds ?? new List<string>());

        if (hasImage && !(node.ReplaceImageOnContentChange && setChanged))
        {
            return; // nothing to do
        }

        // 4. Download posters locally, pad to 4 if fewer (duplicate last entry — 
        //    ASSUMPTION pending verification, see Open Verification Item below)
        var localPaths = new List<string>();
        foreach (var item in top4)
        {
            if (string.IsNullOrEmpty(item.PosterUrl)) continue;
            localPaths.Add(await DownloadPosterToCache(item.PosterUrl, item.StableId, ct));
        }
        while (localPaths.Count > 0 && localPaths.Count < 4)
        {
            localPaths.Add(localPaths[localPaths.Count % top4.Count]); // pad by repeating
        }
        if (localPaths.Count == 0) return; // no posters at all available — nothing to composite

        // 5. Build & call
        var outputPath = Path.Combine(appPaths.DataPath, "channel-sync", "folder-collages", node.Id + ".jpg");
        Directory.CreateDirectory(Path.GetDirectoryName(outputPath));

        var options = new ImageCollageOptions
        {
            Images = localPaths.Select(p => new ItemImageInfo { Path = p, Type = ImageType.Primary }).ToArray(),
            OutputPath = outputPath,
            Width = 400,   // TODO: confirm against whatever standard poster dimensions this plugin already uses elsewhere
            Height = 600
        };

        await imageProcessor.CreateImageCollage(options, ct);

        // 6. Attach to the folder BaseItem — same finishing pattern as ChannelIdentityReconciler.ReapplyChannelImage
        var imageSize = imageProcessor.GetImageSize(outputPath);
        folderItem.SetImage(new ItemImageInfo
        {
            Path = outputPath,
            Type = ImageType.Primary,
            DateModified = DateTimeOffset.UtcNow,
            Width = (int)imageSize.Width,
            Height = (int)imageSize.Height
        }, 0);
        libraryManager.UpdateImages(folderItem);

        // 7. Persist the new "last built from" set so we don't rebuild identically next tick
        cache.LastCollageStableIds = newIds;
        cacheStore.Write(node.Id, cache); // FolderCacheStore already has Write(folderId, cache)
    }
}
Where this runs
Call FolderCollageBuilder.BuildIfNeeded(node, updatedCache, cancellationToken) from FolderTreeSyncTask.SyncSingleNode, right after cacheStore.Write(node.Id, new FolderCache {...}) — i.e. only after a fetch attempt actually happened for that node (if (anyAttempted) block). This naturally satisfies:

First-instantiation case (folder has no image yet, gets checked/built as soon as items exist).
Ongoing case (only proceeds past the hasImage gate if ReplaceImageOnContentChange is on and the top-4 set actually changed).
Runs once per folder per sync cycle, same cadence as everything else in that method — no separate scheduling needed.

Needs FolderCollageBuilder injected into FolderTreeSyncTask's constructor (container-resolvable, same DI pattern already used throughout — confirmed reliable for named concrete-class constructor params per Evidence.md).
Things to wire up / touch, checklist for the new session

Models/FolderCache.cs — add CachedChannelItem.FirstSeenUtc, FolderCache.LastCollageStableIds.
Configuration/FolderTree.cs — add FolderNode.ReplaceImageOnContentChange.
ScheduledTasks/FolderTreeSyncTask.cs — modify ToCache/SyncSingleNode to carry forward FirstSeenUtc for pre-existing StableIds; call new FolderCollageBuilder.BuildIfNeeded after each folder's cache write.
New file Services/FolderCollageBuilder.cs — implementation above, including the poster-download-and-cache helper.
Rules/WebUI/manageComingSoonPage.html + .js — add "Replace image on change" checkbox to the folder-tree node UI (buildFolderNode), wire to node.ReplaceImageOnContentChange, include in save payload (already flows through since FolderNode round-trips via SaveFolderTree/GetFolderTree).
SyncChannel.csproj — no new package references expected; IImageProcessor/IHttpClient/ILibraryManager are all already-referenced Emby interfaces.


Channel Sync — Subfolder Collage Thumbnails: Final Design Summary
Background (confirmed via ILSpy decompilation)

Emby's built-in folder collage generator is structurally unreachable for channel subfolders. CollectionFolderImageProvider : BaseCollageImageProvider gates on item is ICollectionFolder — a channel-tree FolderNode persists as a plain Folder BaseItem (FolderType = Container), never an ICollectionFolder. ChannelImageProvider was also checked and ruled out — it only applies to the Channel BaseItem itself (Supports => item is Channel).
The "borrowed poster" you're currently seeing is not a stored image at all. It comes from Emby.Server.Implementations.Dto.DtoService.AddInheritedImageFromChildren, which runs at API-response time only, Limit = 1 (any one child, first match), and writes only onto the transient BaseItemDto (never item.ImageInfos). Its very first line is if (dto.ImageTags.ContainsKey(ImageType.Primary)) return; — meaning once a real Primary image is set on the folder's BaseItem, this fallback is automatically and cleanly superseded, no cleanup step required.
The actual compositing primitive is ungated and directly callable: IImageProcessor.CreateImageCollage(ImageCollageOptions options, CancellationToken) → SkiaEncoder.CreateImageCollage → StripCollageBuilder.BuildSquareCollage (poster aspect ratios route here, not BuildThumbCollage, which is only used when width/height >= 1.4).
Confirmed: no manual padding logic is needed. StripCollageBuilder.GetNextValidImage cycles/wraps the supplied ItemImageInfo[] with modulo-style index reset across a fixed 4-cell (2×2) grid. Passing 1–4 images auto-repeats to fill all 4 cells; passing 0 leaves a blank/transparent bitmap (no exception).
libraryManager.GetItemsResult(new InternalItemsQuery { ExternalId = ... }) is confirmed viable — ExternalId is a real field on InternalItemsQuery, and Evidence.md already confirms ExternalId round-trips exactly with ChannelItemInfo.Id for folder items.

Requirements

Collage built from the 4 most recently added items in a folder (by presence in that folder's cache), not arbitrary/random.
First instantiation (folder has no Primary image yet): always attempt once ≥1 item exists.
Thereafter: only rebuild if a new per-folder toggle "Replace image on change" is enabled, and the top-4-most-recent set has actually changed.
Must not rebuild/re-download on every 15-minute sync tick regardless of change.

Data model changes
Models/FolderCache.cs
csharppublic class CachedChannelItem
{
    // ...existing fields...
    public DateTimeOffset FirstSeenUtc { get; set; }   // NEW
}

public class FolderCache
{
    // ...existing fields...
    public List<string> LastCollageStableIds { get; set; } = new List<string>();  // NEW
}
Configuration/FolderTree.cs
csharppublic class FolderNode
{
    // ...existing fields...
    public bool ReplaceImageOnContentChange { get; set; } = true;  // NEW — pick default with operator
}
Logic changes
ScheduledTasks/FolderTreeSyncTask.cs

ToCache(...) (currently static, takes FetchedItem + fetchInstanceId) needs a new parameter: a lookup of prior cache items by StableId, so it can carry forward FirstSeenUtc for pre-existing items and only stamp DateTimeOffset.UtcNow for genuinely new StableIds.
In SyncSingleNode, after the existing cacheStore.Write(node.Id, new FolderCache {...}) call (inside the if (anyAttempted) block), call the new FolderCollageBuilder.BuildIfNeeded(node, updatedCache, cancellationToken).

New class: Services/FolderCollageBuilder.cs
Constructor deps: IImageProcessor, IHttpClient, ILibraryManager, IApplicationPaths, FolderCacheStore, ILogger (all container-resolvable, same DI pattern already proven throughout this codebase).
csharppublic async Task BuildIfNeeded(FolderNode node, FolderCache cache, CancellationToken ct)
{
    // 1. Find the folder's real BaseItem
    var query = new InternalItemsQuery { ExternalId = SyncFolderChannel.BuildFolderItemId(node.Id) };
    var folderItem = libraryManager.GetItemsResult(query).Items.FirstOrDefault();
    if (folderItem == null)
    {
        logger.Warn(...); // expected on first sync before Emby persists the folder — same tolerance as ChannelIdentityReconciler
        return;
    }

    bool hasImage = folderItem.HasImage(ImageType.Primary);

    // 2. Top-4 most-recently-added
    var top4 = cache.Items.OrderByDescending(i => i.FirstSeenUtc).Take(4).ToList();
    if (top4.Count == 0) return;

    // 3. Gate
    var newIds = top4.Select(i => i.StableId).ToList();
    bool setChanged = !newIds.SequenceEqual(cache.LastCollageStableIds ?? new List<string>());
    if (hasImage && !(node.ReplaceImageOnContentChange && setChanged)) return;

    // 4. Download posters locally (new helper — persistent cache keyed by StableId, 
    //    since the same movie may appear in multiple folders)
    var localPaths = new List<string>();
    foreach (var item in top4)
    {
        if (string.IsNullOrEmpty(item.PosterUrl)) continue;
        localPaths.Add(await DownloadPosterToCache(item.PosterUrl, item.StableId, ct));
    }
    if (localPaths.Count == 0) return;
    // NO PADDING NEEDED — StripCollageBuilder.GetNextValidImage auto-cycles fewer than 4 images.

    // 5. Build & call — ungated, confirmed callable directly
    var outputPath = Path.Combine(appPaths.DataPath, "channel-sync", "folder-collages", node.Id + ".jpg");
    Directory.CreateDirectory(Path.GetDirectoryName(outputPath));

    var options = new ImageCollageOptions
    {
        Images = localPaths.Select(p => new ItemImageInfo { Path = p, Type = ImageType.Primary }).ToArray(),
        OutputPath = outputPath,
        Width = 400,  // TODO: match existing poster dimension convention
        Height = 600
    };
    await imageProcessor.CreateImageCollage(options, ct);

    // 6. Attach — same finishing pattern as ChannelIdentityReconciler.ReapplyChannelImage
    var imageSize = imageProcessor.GetImageSize(outputPath);
    folderItem.SetImage(new ItemImageInfo
    {
        Path = outputPath, Type = ImageType.Primary, DateModified = DateTimeOffset.UtcNow,
        Width = (int)imageSize.Width, Height = (int)imageSize.Height
    }, 0);
    libraryManager.UpdateImages(folderItem);

    // 7. Persist new baseline
    cache.LastCollageStableIds = newIds;
    cacheStore.Write(node.Id, cache);
}
Also needs a small poster-download helper (new — nothing existing downloads raw bytes; HttpFetchProvider only does JSON GETs): download PosterUrl to channel-sync/folder-thumbs/{StableId}.jpg via IHttpClient, persistently cached by StableId so unchanged posters aren't re-downloaded every sync.
UI changes
Rules/WebUI/manageComingSoonPage.html / .js — add a "Replace image on change" checkbox to buildFolderNode's per-folder controls, bound to node.ReplaceImageOnContentChange. No API surface changes needed — FolderNode already round-trips fully through SaveFolderTree/GetFolderTree.
Checklist for implementation

Models/FolderCache.cs — add FirstSeenUtc, LastCollageStableIds.
Configuration/FolderTree.cs — add ReplaceImageOnContentChange.
ScheduledTasks/FolderTreeSyncTask.cs — modify ToCache/SyncSingleNode for FirstSeenUtc carry-forward; call FolderCollageBuilder.BuildIfNeeded.
New Services/FolderCollageBuilder.cs — full implementation above + poster-download helper.
Rules/WebUI/manageComingSoonPage.html + .js — checkbox UI.
SyncChannel.csproj — no new package refs; all dependencies (IImageProcessor, IHttpClient, ILibraryManager) already available.

Test plan (live, on a real server — nothing further to gain from ILSpy)

Create a test folder with 4 movies (A, B, C, D — added in that order so FirstSeenUtc ordering is unambiguous), each with a real poster.
Sync. Confirm: folder's BaseItem gets a real Primary image (persisted, via SetImage+UpdateImages), composited from all 4 posters; confirm in Emby's UI that the old single-child "inherited" image is gone/replaced (should happen automatically per DtoService behavior above).
Remove one movie (B) from the source so it stops matching. Re-sync. Confirm: LastCollageStableIds change detected, collage rebuilds from the new top-set (now 3 real posters — this also empirically confirms the no-padding-needed conclusion, since Emby will auto-repeat one of the 3 to fill the 4th cell).
Toggle ReplaceImageOnContentChange = false, change the set again (e.g. add E). Confirm the image does not rebuild — the branch most likely to have an inverted-boolean bug, not otherwise caught by steps 2–3.
Re-sync with no change to the top-4 set at all. Confirm nothing gets rewritten/re-downloaded (check logs) — confirms the change-detection gate is actually gating, not rebuilding every 15-minute tick regardless.