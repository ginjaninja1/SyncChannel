// Builds a 2x2 poster collage for a channel subfolder's BaseItem. Confirmed
// end-to-end via CollageTestTask against a plain Folder BaseItem (not just
// the Channel item ChannelIdentityReconciler already handled) — SetImage/
// UpdateImages worked live, no restart needed.
//
// Gating: always attempts once the folder has zero Primary image (first
// instantiation). After that, only rebuilds if FolderNode.ReplaceImageOnContentChange
// ("Image Update" = Y in the UI) is set AND the top-4-most-recent StableId
// set has actually changed since the last build.
namespace SyncChannel.Services
{
    using MediaBrowser.Common.Configuration;
    using MediaBrowser.Common.Net;
    using MediaBrowser.Controller.Drawing;
    using MediaBrowser.Controller.Entities;
    using MediaBrowser.Controller.Library;
    using MediaBrowser.Model.Drawing;
    using MediaBrowser.Model.Entities;
    using MediaBrowser.Model.Logging;
    using SyncChannel.Channels;
    using SyncChannel.Configuration;
    using SyncChannel.Models;
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using System.Threading;
    using System.Threading.Tasks;

    public class FolderCollageBuilder
    {
        private readonly ILibraryManager libraryManager;
        private readonly IImageProcessor imageProcessor;
        private readonly IHttpClient httpClient;
        private readonly IApplicationPaths appPaths;
        private readonly FolderCacheStore cacheStore;
        private readonly ILogger logger;

        public FolderCollageBuilder(
            ILibraryManager libraryManager,
            IImageProcessor imageProcessor,
            IHttpClient httpClient,
            IApplicationPaths appPaths,
            FolderCacheStore cacheStore,
            ILogger logger)
        {
            this.libraryManager = libraryManager;
            this.imageProcessor = imageProcessor;
            this.httpClient = httpClient;
            this.appPaths = appPaths;
            this.cacheStore = cacheStore;
            this.logger = logger;
        }

        public async Task BuildIfNeeded(FolderNode node, FolderCache cache, CancellationToken ct)
        {
            var externalId = SyncFolderChannel.BuildFolderItemId(node.Id);
            var folderItem = libraryManager.GetItemsResult(new InternalItemsQuery
            {
                ExternalId = externalId
            }).Items.FirstOrDefault();

            if (folderItem == null)
            {
                // Expected on first sync before Emby persists the folder —
                // same tolerance as ChannelIdentityReconciler.
                logger.Info("ChannelSync: Collage skipped for '{0}' — no BaseItem found yet for ExternalId='{1}'.", node.DisplayName, externalId);
                return;
            }

            bool hasImage = folderItem.HasImage(ImageType.Primary);

            var top4 = cache.Items
                .Where(i => !string.IsNullOrEmpty(i.PosterUrl))
                .OrderByDescending(i => i.FirstSeenUtc)
                .Take(4)
                .ToList();

            if (top4.Count == 0)
            {
                logger.Info("ChannelSync: Collage skipped for '{0}' — no cached items with a PosterUrl.", node.DisplayName);
                return;
            }

            var newIds = top4.Select(i => i.StableId).ToList();
            bool setChanged = !newIds.SequenceEqual(cache.LastCollageStableIds ?? new List<string>());

            logger.Info("ChannelSync: Collage check for '{0}' — HasImage={1}, ReplaceOnChange={2}, SetChanged={3}, TopIds=[{4}].",
                node.DisplayName, hasImage, node.ReplaceImageOnContentChange, setChanged, string.Join(",", newIds));

            if (hasImage && !(node.ReplaceImageOnContentChange && setChanged))
            {
                logger.Info("ChannelSync: Collage skipped for '{0}' — already has image and rebuild gate not satisfied.", node.DisplayName);
                return;
            }

            var localPaths = new List<string>();
            foreach (var item in top4)
            {
                var path = await DownloadPosterToCache(item.PosterUrl, item.StableId, ct).ConfigureAwait(false);
                if (!string.IsNullOrEmpty(path))
                {
                    localPaths.Add(path);
                }
            }

            if (localPaths.Count == 0)
            {
                logger.Warn("ChannelSync: Collage skipped for '{0}' — 0 of {1} poster download(s) succeeded.", node.DisplayName, top4.Count);
                return;
            }

            var outputPath = Path.Combine(appPaths.DataPath, "channel-sync", "folder-collages", node.Id + ".jpg");
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
                await imageProcessor.CreateImageCollage(options, ct).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Collage build failed for folder '{0}'", ex, node.DisplayName);
                return;
            }

            if (!File.Exists(outputPath))
            {
                logger.Warn("ChannelSync: Collage build reported success but no file exists for folder '{0}' at {1}.", node.DisplayName, outputPath);
                return;
            }

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

                logger.Info("ChannelSync: Collage image applied to folder '{0}' ({1} poster(s)).", node.DisplayName, localPaths.Count);
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Failed to attach collage image to folder '{0}'", ex, node.DisplayName);
                return;
            }

            cache.LastCollageStableIds = newIds;
            cacheStore.Write(node.Id, cache);
        }

        // Persistent, keyed by StableId (not folder) — the same movie can
        // appear in multiple folders, and posters rarely change once set.
        private async Task<string> DownloadPosterToCache(string posterUrl, string stableId, CancellationToken ct)
        {
            var path = Path.Combine(appPaths.DataPath, "channel-sync", "folder-thumbs", stableId + ".jpg");

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
                logger.ErrorException("ChannelSync: Failed to download poster for StableId='{0}' from {1}", ex, stableId, posterUrl);
                return null;
            }
        }
    }
}