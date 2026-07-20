// A new, separate IChannel implementation for the admin-defined folder
// tree. Deliberately NOT a modification of RadarrComingSoonChannel — that
// class keeps working exactly as before, unchanged, as the simple flat
// single-provider channel. This is the tree-aware channel, registered
// alongside it (auto-discovery picks up both — see Evidence.md's Channel
// Registration section; nothing extra needed).
//
// Every behavior here follows directly from the confirmed platform mechanics
// in Evidence.md's "Channel Subfolders" section:
//   - InternalChannelItemQuery.FolderId is exactly the ChannelItemInfo.Id
//     previously returned for that folder -> BuildFolderItemId/ParseFolderNodeId
//     round-trip a FolderNode.Id through it.
//   - Folder items use Type=Folder, FolderType=Container for plain
//     admin-created folders (maps to a generic Folder BaseItem, not Series/
//     Season/PhotoAlbum).
//   - Reconciliation happens per-parent-folder in Emby's own ChannelManager,
//     so this class only ever needs to return the direct children of
//     whichever FolderId it was asked about — never the whole tree at once.
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

        // Fixed name (not read from config) — unlike RadarrComingSoonChannel,
        // this channel's identity isn't tied to a single provider's display
        // name, so there's no "rename creates an orphan" concern to manage
        // here the way RadarrChannelIdentityReconciler handles for the
        // single-provider channel.
        public string Name => "Coming Soon";

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

            // Child folders first.
            foreach (var child in targetNode.Children)
            {
                items.Add(BuildFolderItem(child));
            }

            // Then this node's own fetched media items, from its own cache
            // file only — never the whole tree. Cheap, and matches how
            // Emby's own reconciliation is scoped (see Evidence.md).
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
            var folderId = ParseItemOwningFolderId(id);
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

        // -----------------------------------------------------------------
        // Id encoding. Folder ids and item ids share one Id-space
        // (InternalChannelItemQuery.FolderId is only ever set to a value
        // this class previously returned as a folder item's Id — see
        // Evidence.md) but need to be told apart on the way back in, and an
        // item id also needs to carry which folder's cache it lives in so
        // GetChannelItemMediaInfo doesn't have to search the whole tree.
        // -----------------------------------------------------------------

        internal static string BuildFolderItemId(string folderNodeId) => FolderIdPrefix + folderNodeId;

        private static string ParseFolderNodeId(string channelItemId) =>
            channelItemId != null && channelItemId.StartsWith(FolderIdPrefix, StringComparison.Ordinal)
                ? channelItemId.Substring(FolderIdPrefix.Length)
                : null;

        // Item ids encode both the owning folder and the provider's stable
        // id: "syncchannel-item-{folderId}::{stableId}". Only this class
        // ever parses or builds these — GetChannelItemMediaInfo needs the
        // folder segment to find the right cache file cheaply.
        internal static string BuildItemId(string folderNodeId, string stableId) =>
            ItemIdPrefix + folderNodeId + "::" + stableId;

        private static string ParseItemOwningFolderId(string channelItemId)
        {
            if (channelItemId == null || !channelItemId.StartsWith(ItemIdPrefix, StringComparison.Ordinal))
            {
                return null;
            }

            var remainder = channelItemId.Substring(ItemIdPrefix.Length);
            var separatorIndex = remainder.IndexOf("::", StringComparison.Ordinal);
            return separatorIndex < 0 ? null : remainder.Substring(0, separatorIndex);
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
                ImageUrl = item.PosterUrl
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

        // Falls back to the same embedded default stub used by
        // RadarrComingSoonChannel if a folder's cache hasn't set one yet
        // (e.g. before the first sync has run for that folder).
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
