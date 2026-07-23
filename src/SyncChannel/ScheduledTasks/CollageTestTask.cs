// DEV-ONLY, manual-trigger proof-of-concept for subfolder collage thumbnails.
// Confirms three things end-to-end on a real server before this logic is
// folded into FolderTreeSyncTask:
//   1. A subfolder's BaseItem is findable via InternalItemsQuery.ExternalId.
//   2. IImageProcessor.CreateImageCollage produces a file SetImage/UpdateImages accepts.
//   3. Whether the result is visible live or needs a restart (per Evidence.md's
//      SetImage/UpdateImages caveats — those were confirmed against a Channel
//      BaseItem, not yet against a plain Folder BaseItem).
//
// Deliberately no change-detection, no FirstSeenUtc, no config toggle, no
// persistent poster cache — this only proves the mechanism. Targets the
// first non-root folder found with >=1 cached item carrying a PosterUrl.
// Remove this file once the real FolderCollageBuilder is built and tested.
namespace SyncChannel.ScheduledTasks
{
    using MediaBrowser.Common.Configuration;
    using MediaBrowser.Common.Net;
    using MediaBrowser.Controller.Drawing;
    using MediaBrowser.Controller.Entities;
    using MediaBrowser.Controller.Library;
    using MediaBrowser.Model.Drawing;
    using MediaBrowser.Model.Entities;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.Tasks;
    using SyncChannel.Channels;
    using SyncChannel.Configuration;
    using SyncChannel.Models;
    using SyncChannel.Services;
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using System.Threading;
    using System.Threading.Tasks;

    public class CollageTestTask : IScheduledTask
    {
        private readonly FolderTreeStore treeStore;
        private readonly FolderCacheStore cacheStore;
        private readonly ILibraryManager libraryManager;
        private readonly IImageProcessor imageProcessor;
        private readonly IHttpClient httpClient;
        private readonly IApplicationPaths appPaths;
        private readonly ILogger logger;

        public CollageTestTask(
            FolderTreeStore treeStore,
            FolderCacheStore cacheStore,
            ILibraryManager libraryManager,
            IImageProcessor imageProcessor,
            IHttpClient httpClient,
            IApplicationPaths appPaths,
            ILogger logger)
        {
            this.treeStore = treeStore;
            this.cacheStore = cacheStore;
            this.libraryManager = libraryManager;
            this.imageProcessor = imageProcessor;
            this.httpClient = httpClient;
            this.appPaths = appPaths;
            this.logger = logger;
        }

        public string Name => "Collage Test (dev)";
        public string Key => "ChannelSync-CollageTest";
        public string Description =>
            "DEV ONLY: builds a test collage on the first subfolder found with cached posters, to prove IImageProcessor.CreateImageCollage + SetImage/UpdateImages work against a plain Folder BaseItem. Not for production use — remove once FolderCollageBuilder is built.";
        public string Category => "Channel Sync";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => Array.Empty<TaskTriggerInfo>();

        public async Task Execute(CancellationToken cancellationToken, IProgress<double> progress)
        {
            var tree = treeStore.Load();
            var (targetNode, cache) = FindFirstFolderWithPosters(tree.RootFolder, isRoot: true);

            if (targetNode == null)
            {
                logger.Warn("ChannelSync: CollageTestTask found no subfolder with cached items carrying a PosterUrl — nothing to test.");
                return;
            }

            logger.Info("ChannelSync: CollageTestTask targeting folder '{0}' (Id={1}), {2} cached item(s) with posters.",
                targetNode.DisplayName, targetNode.Id, cache.Items.Count(i => !string.IsNullOrEmpty(i.PosterUrl)));

            // Step 1: resolve the folder's real BaseItem via ExternalId.
            var externalId = SyncFolderChannel.BuildFolderItemId(targetNode.Id);
            var folderItem = libraryManager.GetItemsResult(new InternalItemsQuery
            {
                ExternalId = externalId
            }).Items.FirstOrDefault();

            if (folderItem == null)
            {
                logger.Warn("ChannelSync: CollageTestTask — no BaseItem found for ExternalId='{0}'. Folder not yet persisted by Emby (run a real sync first) or ExternalId lookup did not resolve.", externalId);
                return;
            }

            logger.Info("ChannelSync: CollageTestTask — resolved BaseItem InternalId={0}, HasPrimaryImage={1}.",
                folderItem.InternalId, folderItem.HasImage(ImageType.Primary));

            // Step 2: download up to 4 posters to a scratch path.
            var top4 = cache.Items.Where(i => !string.IsNullOrEmpty(i.PosterUrl)).Take(4).ToList();
            var localPaths = new List<string>();

            foreach (var item in top4)
            {
                var path = await DownloadPosterAsync(item.PosterUrl, item.StableId, cancellationToken).ConfigureAwait(false);
                if (!string.IsNullOrEmpty(path))
                {
                    localPaths.Add(path);
                }
            }

            if (localPaths.Count == 0)
            {
                logger.Warn("ChannelSync: CollageTestTask — no posters downloaded successfully, aborting.");
                return;
            }

            logger.Info("ChannelSync: CollageTestTask — downloaded {0} poster(s) locally.", localPaths.Count);

            // Step 3: build the collage.
            var outputPath = Path.Combine(appPaths.DataPath, "channel-sync", "collage-test", targetNode.Id + ".jpg");
            var outputDir = Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrEmpty(outputDir) && !Directory.Exists(outputDir))
            {
                Directory.CreateDirectory(outputDir);
            }

            var options = new ImageCollageOptions
            {
                Images = localPaths.Select(p => new ItemImageInfo { Path = p, Type = ImageType.Primary }).ToArray(),
                OutputPath = outputPath,
                Width = 400,
                Height = 600
            };

            try
            {
                await imageProcessor.CreateImageCollage(options, cancellationToken).ConfigureAwait(false);
                logger.Info("ChannelSync: CollageTestTask — CreateImageCollage succeeded, output at {0}.", outputPath);
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: CollageTestTask — CreateImageCollage failed", ex);
                return;
            }

            if (!File.Exists(outputPath))
            {
                logger.Warn("ChannelSync: CollageTestTask — CreateImageCollage reported success but no file exists at {0}.", outputPath);
                return;
            }

            // Step 4: attach to the folder BaseItem — same finishing pattern as
            // ChannelIdentityReconciler.ReapplyChannelImage, now against a Folder.
            try
            {
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

                logger.Info(
                    "ChannelSync: CollageTestTask — SetImage/UpdateImages called against folder BaseItem InternalId={0}. Check Emby's UI now WITHOUT restarting the server first, to determine if a Folder behaves like Channel did (live) or needs a restart.",
                    folderItem.InternalId);
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: CollageTestTask — SetImage/UpdateImages failed against folder BaseItem", ex);
                return;
            }

            progress.Report(100);
        }

        // Root is deliberately excluded — SyncFolderChannel never builds a
        // ChannelItemInfo/BaseItem for the root folder itself (BuildFolderItem
        // is only called for targetNode.Children in GetChannelItems), so
        // ExternalId="syncchannel-folder-{rootId}" can never resolve. Only a
        // real subfolder (a child, at any depth) is a valid collage target.
        private (FolderNode Node, FolderCache Cache) FindFirstFolderWithPosters(FolderNode node, bool isRoot)
        {
            if (!isRoot)
            {
                var cache = this.cacheStore.Read(node.Id);
                if (cache.Items.Any(i => !string.IsNullOrEmpty(i.PosterUrl)))
                {
                    return (node, cache);
                }
            }

            foreach (var child in node.Children)
            {
                var (foundNode, foundCache) = FindFirstFolderWithPosters(child, isRoot: false);
                if (foundNode != null)
                {
                    return (foundNode, foundCache);
                }
            }

            return (null, null);
        }

        private FolderCache CacheForNode(FolderNode node) => cacheStoreRead(node.Id);

        // Small indirection so FindFirstFolderWithPosters can stay static
        // without capturing `this` awkwardly across the local recursive fn.
        private FolderCache cacheStoreRead(string folderId) => this.cacheStore.Read(folderId);

        private async Task<string> DownloadPosterAsync(string posterUrl, string cacheKey, CancellationToken ct)
        {
            var path = Path.Combine(appPaths.DataPath, "channel-sync", "collage-test", "posters", cacheKey + ".jpg");

            if (File.Exists(path))
            {
                return path;
            }

            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            try
            {
                var options = new HttpRequestOptions { Url = posterUrl, CancellationToken = ct };

                using (var response = await httpClient.GetResponse(options).ConfigureAwait(false))
                using (var responseStream = response.Content)
                using (var fileStream = File.Create(path))
                {
                    await responseStream.CopyToAsync(fileStream).ConfigureAwait(false);
                }

                return path;
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: CollageTestTask — failed to download poster from {0}", ex, posterUrl);
                return null;
            }
        }
    }
}