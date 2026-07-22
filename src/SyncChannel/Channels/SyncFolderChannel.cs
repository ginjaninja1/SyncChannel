namespace SyncChannel.Channels
{
    using SyncChannel.Configuration;
    using SyncChannel.Models;
    using SyncChannel.Services;
    using MediaBrowser.Common.Configuration;
    using MediaBrowser.Controller.Channels;
    using MediaBrowser.Model.Channels;
    using MediaBrowser.Model.Drawing;
    using MediaBrowser.Model.Dto;
    using MediaBrowser.Model.Entities;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.MediaInfo;
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using System.Threading;
    using System.Threading.Tasks;
    using MediaBrowser.Controller.Providers;

    public class SyncFolderChannel : IChannel, IRequiresMediaInfoCallback
    {
        private const string FolderIdPrefix = "syncchannel-folder-";
        private const string ItemIdPrefix = "syncchannel-item-";
        private const string SeriesIdPrefix = "syncchannel-series-";
        private const string SeasonIdPrefix = "syncchannel-season-";
        private const string EpisodeIdPrefix = "syncchannel-episode-";

        private readonly FolderTreeStore treeStore;
        private readonly FolderCacheStore cacheStore;
        private readonly IApplicationPaths appPaths;
        private readonly ILogger logger;

        public SyncFolderChannel(
            FolderTreeStore treeStore,
            FolderCacheStore cacheStore,
            IApplicationPaths appPaths,
            ILogger logger)
        {
            this.treeStore = treeStore;
            this.cacheStore = cacheStore;
            this.appPaths = appPaths;
            this.logger = logger;
        }

        public string Name => SyncChannelPlugin.Instance.Configuration.ChannelName;

        public string Description => "Admin-organized coming-soon folders, synced from Radarr/Sonarr and other configured sources.";

        public ChannelParentalRating ParentalRating => ChannelParentalRating.GeneralAudience;

        public IEnumerable<ImageType> GetSupportedChannelImages()
        {
            return new List<ImageType> { ImageType.Primary };
        }

        public Task<DynamicImageResponse> GetChannelImage(ImageType type, CancellationToken cancellationToken)
        {
            var pluginType = typeof(SyncChannelPlugin);
            var resourceName = pluginType.Namespace + ".ComingSoonChannel2.png";
            var stream = pluginType.Assembly.GetManifestResourceStream(resourceName);

            return Task.FromResult(new DynamicImageResponse
            {
                Format = ImageFormat.Png,
                Protocol = MediaProtocol.File,
                Stream = stream
            });
        }

        public Task<ChannelItemResult> GetChannelItems(InternalChannelItemQuery query, CancellationToken cancellationToken)
        {
            // Synthetic Series -> Season -> Episode branch. Checked before
            // the admin-folder-tree logic below, since these ids never
            // correspond to a FolderNode.
            if (!string.IsNullOrEmpty(query.FolderId))
            {
                if (query.FolderId.StartsWith(SeriesIdPrefix, StringComparison.Ordinal))
                {
                    return Task.FromResult(BuildSeasonListing(query.FolderId));
                }

                if (query.FolderId.StartsWith(SeasonIdPrefix, StringComparison.Ordinal))
                {
                    return Task.FromResult(BuildEpisodeListing(query.FolderId));
                }
            }

            var tree = treeStore.Load();

            FolderNode targetNode;
            if (string.IsNullOrEmpty(query.FolderId))
            {
                targetNode = tree.RootFolder;
            }
            else
            {
                var nodeId = ParseFolderNodeId(query.FolderId);
                targetNode = nodeId == null ? null : FolderTreeStore.FindNode(tree.RootFolder, nodeId);
            }

            if (targetNode == null)
            {
                logger.Warn("ChannelSync: GetChannelItems called for unknown FolderId='{0}' — returning empty.", query.FolderId);
                return Task.FromResult(new ChannelItemResult { Items = new List<ChannelItemInfo>(), TotalRecordCount = 0 });
            }

            var items = new List<ChannelItemInfo>();

            foreach (var child in targetNode.Children)
            {
                items.Add(BuildFolderItem(child));
            }

            var cache = cacheStore.Read(targetNode.Id);
            foreach (var cached in cache.Items)
            {
                var info = ToChannelItemInfo(cached, targetNode.Id, cache.StubVideoPath);
                if (info != null)
                {
                    items.Add(info);
                }
            }

            logger.Info(
                "ChannelSync: GetChannelItems FolderId='{0}' ('{1}') returning {2} folder(s) + {3} item(s).",
                query.FolderId ?? "(root)", targetNode.DisplayName, targetNode.Children.Count, cache.Items.Count);

            return Task.FromResult(new ChannelItemResult { Items = items, TotalRecordCount = items.Count });
        }

        public Task<IEnumerable<MediaSourceInfo>> GetChannelItemMediaInfo(string id, CancellationToken cancellationToken)
        {
            string folderId = id.StartsWith(EpisodeIdPrefix, StringComparison.Ordinal)
                ? ParseOwningFolderIdFromSyntheticId(id.Substring(EpisodeIdPrefix.Length))
                : ParseItemOwningFolderId(id);

            var stubVideoPath = folderId == null
                ? string.Empty
                : cacheStore.Read(folderId).StubVideoPath;

            if (string.IsNullOrEmpty(stubVideoPath))
            {
                stubVideoPath = ResolveDefaultStubPath();
            }

            if (string.IsNullOrEmpty(stubVideoPath) || !File.Exists(stubVideoPath))
            {
                logger.Warn("ChannelSync: GetChannelItemMediaInfo returning empty for Id='{0}' — no valid stub path.", id);
                return Task.FromResult<IEnumerable<MediaSourceInfo>>(Array.Empty<MediaSourceInfo>());
            }

            var source = BuildMediaSource(id, stubVideoPath);
            return Task.FromResult<IEnumerable<MediaSourceInfo>>(new List<MediaSourceInfo> { source });
        }

        internal static string BuildFolderItemId(string folderNodeId) => FolderIdPrefix + folderNodeId;

        private static string ParseFolderNodeId(string channelItemId) =>
            channelItemId != null && channelItemId.StartsWith(FolderIdPrefix, StringComparison.Ordinal)
                ? channelItemId.Substring(FolderIdPrefix.Length)
                : null;

        internal static string BuildItemId(string folderNodeId, string stableId) =>
            ItemIdPrefix + folderNodeId + "::" + stableId;

        // Shared "folderNodeId::stableId" split, used both by flat media
        // items (ItemIdPrefix) and by the synthetic series/season/episode
        // chain (which wraps the same folderNodeId::stableId payload under
        // extra prefixes).
        private static string ParseFolderNodeIdFromPayload(string payload)
        {
            var separatorIndex = payload.IndexOf("::", StringComparison.Ordinal);
            return separatorIndex < 0 ? null : payload.Substring(0, separatorIndex);
        }

        private static string ParseItemOwningFolderId(string channelItemId)
        {
            if (channelItemId == null || !channelItemId.StartsWith(ItemIdPrefix, StringComparison.Ordinal))
            {
                return null;
            }

            return ParseFolderNodeIdFromPayload(channelItemId.Substring(ItemIdPrefix.Length));
        }

        // Strips whichever synthetic wrapper prefixes (Season/Series) are
        // present, down to the raw "folderNodeId::stableId" payload, then
        // extracts the folderNodeId the same way ParseItemOwningFolderId does.
        private static string ParseOwningFolderIdFromSyntheticId(string seasonOrSeriesId)
        {
            var value = seasonOrSeriesId;

            if (value.StartsWith(SeasonIdPrefix, StringComparison.Ordinal))
            {
                value = value.Substring(SeasonIdPrefix.Length);
            }

            if (value.StartsWith(SeriesIdPrefix, StringComparison.Ordinal))
            {
                value = value.Substring(SeriesIdPrefix.Length);
            }

            return ParseFolderNodeIdFromPayload(value);
        }

        private static ChannelItemInfo BuildFolderItem(FolderNode node) => new ChannelItemInfo
        {
            Id = BuildFolderItemId(node.Id),
            Name = node.DisplayName,
            Type = ChannelItemType.Folder,
            FolderType = ChannelFolderType.Container
        };

        private ChannelItemInfo ToChannelItemInfo(CachedChannelItem item, string folderNodeId, string stubVideoPath)
        {
            if (string.IsNullOrEmpty(item.StableId))
            {
                logger.Warn("ChannelSync: Cached item '{0}' in folder '{1}' has no StableId — dropping.", item.Title, folderNodeId);
                return null;
            }

            if (item.ObjectKind == ChannelObjectKind.Series)
            {
                return BuildSeriesFolderItem(item, folderNodeId);
            }

            var itemId = BuildItemId(folderNodeId, item.StableId);

            var info = new ChannelItemInfo
            {
                Id = itemId,
                Name = item.Title,
                OriginalTitle = item.OriginalTitle,
                Overview = item.Overview,
                Type = ChannelItemType.Media,
                MediaType = ChannelMediaType.Video,
                ContentType = ChannelMediaContentType.Movie,
                ProductionYear = item.Year,
                ImageUrl = item.PosterUrl,
                ForceUpdate = true
            };

            foreach (var kvp in item.ProviderIds)
            {
                info.ProviderIds[kvp.Key] = kvp.Value;
            }

            if (!string.IsNullOrEmpty(stubVideoPath))
            {
                info.MediaSources = new List<MediaSourceInfo> { BuildMediaSource(itemId, stubVideoPath) };
            }

            return info;
        }

        private static ChannelItemInfo BuildSeriesFolderItem(CachedChannelItem item, string folderNodeId)
        {
            var info = new ChannelItemInfo
            {
                Id = SeriesIdPrefix + folderNodeId + "::" + item.StableId,
                Name = item.Title,
                OriginalTitle = item.OriginalTitle,
                Overview = item.Overview,
                Type = ChannelItemType.Folder,
                FolderType = ChannelFolderType.Series,
                ProductionYear = item.Year,
                ImageUrl = item.PosterUrl,
                // GetChannelItemEntity only re-copies Name/Overview/
                // ProviderIds/etc on isNew || ForceUpdate — and the
                // Container-only "just refresh Name" fallback path
                // explicitly excludes FolderType.Series. Without this,
                // a Sonarr rename would never propagate on resync.
                ForceUpdate = true
            };

            foreach (var kvp in item.ProviderIds)
            {
                info.ProviderIds[kvp.Key] = kvp.Value;
            }

            return info;
        }

        private ChannelItemResult BuildSeasonListing(string seriesId)
        {
            var season = new ChannelItemInfo
            {
                Id = SeasonIdPrefix + seriesId,
                Name = "Season 1",
                Type = ChannelItemType.Folder,
                FolderType = ChannelFolderType.Season,
                IndexNumber = 1,
                ForceUpdate = true
            };

            return new ChannelItemResult { Items = new List<ChannelItemInfo> { season }, TotalRecordCount = 1 };
        }

        private ChannelItemResult BuildEpisodeListing(string seasonId)
        {
            var folderNodeId = ParseOwningFolderIdFromSyntheticId(seasonId);
            var stubVideoPath = folderNodeId == null
                ? string.Empty
                : cacheStore.Read(folderNodeId).StubVideoPath;

            if (string.IsNullOrEmpty(stubVideoPath))
            {
                stubVideoPath = ResolveDefaultStubPath();
            }

            var episodeId = EpisodeIdPrefix + seasonId;

            var episode = new ChannelItemInfo
            {
                Id = episodeId,
                Name = "Episode 1",
                Type = ChannelItemType.Media,
                MediaType = ChannelMediaType.Video,
                ContentType = ChannelMediaContentType.Episode,
                IndexNumber = 1,
                ParentIndexNumber = 1,
                ForceUpdate = true
            };

            if (!string.IsNullOrEmpty(stubVideoPath))
            {
                episode.MediaSources = new List<MediaSourceInfo> { BuildMediaSource(episodeId, stubVideoPath) };
            }

            return new ChannelItemResult { Items = new List<ChannelItemInfo> { episode }, TotalRecordCount = 1 };
        }

        private static MediaSourceInfo BuildMediaSource(string itemId, string stubVideoPath) => new MediaSourceInfo
        {
            Id = itemId,
            Path = stubVideoPath,
            Protocol = MediaProtocol.File,
            Container = Path.GetExtension(stubVideoPath).TrimStart('.').ToLowerInvariant(),
            IsRemote = false,
            SupportsDirectPlay = true,
            SupportsDirectStream = true,
            SupportsTranscoding = true,
            Name = "Coming Soon"
        };

        private string ResolveDefaultStubPath()
        {
            const string DefaultStubResourceName = "SyncChannel.comingsoon.mp4";
            const string DefaultStubCacheFileName = "syncfolder-stub-default.mp4";

            var defaultPath = Path.Combine(appPaths.DataPath, "channel-sync", DefaultStubCacheFileName);
            if (File.Exists(defaultPath))
            {
                return defaultPath;
            }

            try
            {
                var dir = Path.GetDirectoryName(defaultPath);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                {
                    Directory.CreateDirectory(dir);
                }

                var asm = typeof(SyncChannelPlugin).Assembly;
                using (var resourceStream = asm.GetManifestResourceStream(DefaultStubResourceName))
                {
                    if (resourceStream == null)
                    {
                        return string.Empty;
                    }

                    using (var fileStream = File.Create(defaultPath))
                    {
                        resourceStream.CopyTo(fileStream);
                    }
                }

                return defaultPath;
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Failed to extract default stub video for SyncFolderChannel", ex);
                return string.Empty;
            }
        }
    }
}