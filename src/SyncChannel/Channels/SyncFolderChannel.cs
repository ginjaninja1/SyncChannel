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

        // MusicArtistAlbum kind — mirrors Series/Season/Episode's three-level
        // synthetic shape, since the endpoint only ever returns one flat row
        // per artist (no real album/track-level data to enumerate).
        private const string ArtistIdPrefix = "syncchannel-artist-";
        private const string AlbumIdPrefix = "syncchannel-album-";
        private const string SongIdPrefix = "syncchannel-song-";

        // PhotoAlbum kind — only two levels (PhotoAlbum -> Photo), since a
        // real image URL is available per row and doesn't need a second
        // synthetic layer the way Series/Music do.
        private const string PhotoAlbumIdPrefix = "syncchannel-photoalbum-";
        private const string PhotoIdPrefix = "syncchannel-photo-";

        // GenericContainer kind — N admin-configured levels. Level is
        // encoded in the id itself ("syncchannel-container-{level}-...")
        // since depth is schema-defined per item, not fixed like the others.
        private const string ContainerIdPrefix = "syncchannel-container-";

        // DisplayCard kind — a picture + name, nothing underneath, nothing
        // to play. Built as Type=Media/MediaType=Video/ContentType=Trailer,
        // which Emby's ChannelManager construction switch maps to a real
        // Photo BaseItem (confirmed via ILSpy — see Evidence.md): a Photo
        // IS its picture, so this reads as "just an image" cleanly, with
        // no play button to error on click.
        private const string CardIdPrefix = "syncchannel-card-";

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
            // Synthetic-chain branches. Checked before the admin-folder-tree
            // logic below, since none of these ids ever correspond to a
            // FolderNode. Longer/more-specific prefixes are checked first
            // where one prefix could otherwise be a substring confusion risk
            // (none currently overlap, but ordering is kept deliberate).
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

                if (query.FolderId.StartsWith(ArtistIdPrefix, StringComparison.Ordinal))
                {
                    return Task.FromResult(BuildAlbumListing(query.FolderId));
                }

                if (query.FolderId.StartsWith(AlbumIdPrefix, StringComparison.Ordinal))
                {
                    return Task.FromResult(BuildSongListing(query.FolderId));
                }

                if (query.FolderId.StartsWith(PhotoAlbumIdPrefix, StringComparison.Ordinal))
                {
                    return Task.FromResult(BuildPhotoListing(query.FolderId));
                }

                if (query.FolderId.StartsWith(ContainerIdPrefix, StringComparison.Ordinal))
                {
                    return Task.FromResult(BuildContainerLevelListing(query.FolderId));
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
            // Photo doesn't implement IHasMediaSources (confirmed via ILSpy)
            // — its Path is set directly from ChannelItemInfo.MediaSources at
            // creation time in GetChannelItemEntity, not via this callback.
            // Nothing to do here for photo ids.
            if (id.StartsWith(PhotoIdPrefix, StringComparison.Ordinal) || id.StartsWith(CardIdPrefix, StringComparison.Ordinal))
            {
                return Task.FromResult<IEnumerable<MediaSourceInfo>>(Array.Empty<MediaSourceInfo>());
            }

            string folderId = id.StartsWith(EpisodeIdPrefix, StringComparison.Ordinal)
                ? ParseOwningFolderIdFromSyntheticId(id.Substring(EpisodeIdPrefix.Length))
                : id.StartsWith(SongIdPrefix, StringComparison.Ordinal)
                    ? ParseOwningFolderIdFromSyntheticId(id.Substring(SongIdPrefix.Length))
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

            // NOTE: Song leaves currently reuse the same video stub file as
            // everything else — there is no dedicated audio stub shipped
            // with the plugin yet. This proves the Artist->Album->Song
            // shape and playback wiring end-to-end, but a real audio file
            // would be needed for a genuinely correct listening experience.
            // Flagging rather than guessing at an assumption here.
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

        // Returns the ExternalId of the "real" top-level Emby BaseItem a
        // cached item becomes, for every kind whose ChannelItemInfo carries
        // an ImageUrl. This is the single source of truth for that id
        // shape — every Build*Item method below encodes its own prefix +
        // folderNodeId + "::" + StableId, and ItemPosterRefreshService needs
        // to reconstruct the same id from outside this class to find and
        // force-refresh a changed poster (see Evidence.md: ChannelManager
        // only calls SetImage when the BaseItem has no Primary image yet,
        // so a changed PosterUrl otherwise never propagates on resync).
        // Returns null for DisplayCard, which builds a Photo BaseItem
        // instead — Photo.Path is reassigned unconditionally by
        // ChannelManager on every sync, so it already self-heals and needs
        // no help here.
        internal static string BuildImageBearingExternalId(CachedChannelItem item, string folderNodeId)
        {
            switch (item.ObjectKind)
            {
                case ChannelObjectKind.Series:
                    return SeriesIdPrefix + folderNodeId + "::" + item.StableId;

                case ChannelObjectKind.MusicArtistAlbum:
                    return ArtistIdPrefix + folderNodeId + "::" + item.StableId;

                case ChannelObjectKind.PhotoAlbum:
                    return PhotoAlbumIdPrefix + folderNodeId + "::" + item.StableId;

                case ChannelObjectKind.GenericContainer:
                    // Only the level-0 folder carries an ImageUrl (see
                    // BuildContainerFolderItem) — deeper levels and the
                    // leaf never do.
                    return ContainerIdPrefix + "0-" + folderNodeId + "::" + item.StableId;

                case ChannelObjectKind.DisplayCard:
                    return null;

                case ChannelObjectKind.FlatMedia:
                default:
                    return BuildItemId(folderNodeId, item.StableId);
            }
        }

        // Shared "folderNodeId::stableId" split, used by every kind's
        // top-level item id (flat media, series, artist, photo album,
        // container level 0) and by every synthetic child id that wraps one.
        private static string ParseFolderNodeIdFromPayload(string payload)
        {
            var separatorIndex = payload.IndexOf("::", StringComparison.Ordinal);
            return separatorIndex < 0 ? null : payload.Substring(0, separatorIndex);
        }

        private static string ParseStableIdFromPayload(string payload)
        {
            var separatorIndex = payload.IndexOf("::", StringComparison.Ordinal);
            return separatorIndex < 0 ? null : payload.Substring(separatorIndex + 2);
        }

        private static string ParseItemOwningFolderId(string channelItemId)
        {
            if (channelItemId == null || !channelItemId.StartsWith(ItemIdPrefix, StringComparison.Ordinal))
            {
                return null;
            }

            return ParseFolderNodeIdFromPayload(channelItemId.Substring(ItemIdPrefix.Length));
        }

        // Strips whichever synthetic wrapper prefixes are present, down to
        // the raw "folderNodeId::stableId" payload, then extracts the
        // folderNodeId. Handles every wrapper depth in use: Season/Series
        // (2 deep), Album/Artist (2 deep), and PhotoAlbum (1 deep, but
        // harmless to run through the same strip since PhotoAlbumIdPrefix
        // wrapping isn't present for photo ids — those go through
        // BuildPhotoListing's own parse instead).
        private static string ParseOwningFolderIdFromSyntheticId(string wrappedId)
        {
            var value = wrappedId;

            if (value.StartsWith(SeasonIdPrefix, StringComparison.Ordinal))
            {
                value = value.Substring(SeasonIdPrefix.Length);
            }

            if (value.StartsWith(SeriesIdPrefix, StringComparison.Ordinal))
            {
                value = value.Substring(SeriesIdPrefix.Length);
            }

            if (value.StartsWith(AlbumIdPrefix, StringComparison.Ordinal))
            {
                value = value.Substring(AlbumIdPrefix.Length);
            }

            if (value.StartsWith(ArtistIdPrefix, StringComparison.Ordinal))
            {
                value = value.Substring(ArtistIdPrefix.Length);
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

        private CachedChannelItem FindCachedItem(string folderNodeId, string stableId)
        {
            if (folderNodeId == null || stableId == null)
            {
                return null;
            }

            return cacheStore.Read(folderNodeId).Items
                .FirstOrDefault(i => string.Equals(i.StableId, stableId, StringComparison.OrdinalIgnoreCase));
        }

        private ChannelItemInfo ToChannelItemInfo(CachedChannelItem item, string folderNodeId, string stubVideoPath)
        {
            if (string.IsNullOrEmpty(item.StableId))
            {
                logger.Warn("ChannelSync: Cached item '{0}' in folder '{1}' has no StableId — dropping.", item.Title, folderNodeId);
                return null;
            }

            switch (item.ObjectKind)
            {
                case ChannelObjectKind.Series:
                    return BuildSeriesFolderItem(item, folderNodeId);

                case ChannelObjectKind.MusicArtistAlbum:
                    return BuildArtistFolderItem(item, folderNodeId);

                case ChannelObjectKind.PhotoAlbum:
                    return BuildPhotoAlbumFolderItem(item, folderNodeId);

                case ChannelObjectKind.GenericContainer:
                    return BuildContainerFolderItem(item, folderNodeId, level: 0);

                case ChannelObjectKind.DisplayCard:
                    return BuildDisplayCardItem(item, folderNodeId);

                case ChannelObjectKind.FlatMedia:
                default:
                    return BuildFlatMediaItem(item, folderNodeId, stubVideoPath);
            }
        }

        private ChannelItemInfo BuildDisplayCardItem(CachedChannelItem item, string folderNodeId)
        {
            var cardId = CardIdPrefix + folderNodeId + "::" + item.StableId;

            var info = new ChannelItemInfo
            {
                Id = cardId,
                Name = item.Title,
                Overview = item.Overview,
                // Confirmed via live test (Evidence.md): Type=Media,
                // MediaType=Video, ContentType=Trailer is what Emby's
                // construction switch actually maps to a real Photo
                // BaseItem — same mechanism PhotoAlbum's leaf already uses.
                // A Photo IS its picture; there's no separate thumbnail-vs-
                // content split to fight with here, unlike the earlier
                // Folder+ImageUrl approach (which relies on SetImage against
                // a plain Folder — an open, previously-unconfirmed question
                // per Evidence.md, and apparently doesn't render reliably).
                Type = ChannelItemType.Media,
                MediaType = ChannelMediaType.Video,
                ContentType = ChannelMediaContentType.Trailer,
                ForceUpdate = true
            };

            foreach (var kvp in item.ProviderIds)
            {
                info.ProviderIds[kvp.Key] = kvp.Value;
            }

            if (string.IsNullOrEmpty(item.PosterUrl))
            {
                logger.Warn("ChannelSync: DisplayCard item '{0}' in folder '{1}' has no PosterUrl — will show with no image.", item.Title, folderNodeId);
                return info;
            }

            logger.Info("ChannelSync: DisplayCard item '{0}' using PosterUrl '{1}' as its picture.", item.Title, item.PosterUrl);
            info.MediaSources = new List<MediaSourceInfo> { BuildRemoteOrLocalMediaSource(cardId, item.PosterUrl) };
            return info;
        }

        private ChannelItemInfo BuildFlatMediaItem(CachedChannelItem item, string folderNodeId, string stubVideoPath)
        {
            var itemId = BuildItemId(folderNodeId, item.StableId);

            var info = new ChannelItemInfo
            {
                Id = itemId,
                Name = item.Title,
                OriginalTitle = item.OriginalTitle,
                Overview = item.Overview,
                Type = ChannelItemType.Media,
                MediaType = ToChannelMediaType(item.LeafMediaType),
                ContentType = ToChannelMediaContentType(item.LeafContentType),
                ProductionYear = item.Year,
                ImageUrl = item.PosterUrl,
                ForceUpdate = true
            };

            foreach (var kvp in item.ProviderIds)
            {
                info.ProviderIds[kvp.Key] = kvp.Value;
            }

            if (string.IsNullOrEmpty(item.PosterUrl))
            {
                logger.Warn("ChannelSync: FlatMedia item '{0}' in folder '{1}' has no PosterUrl — will show with no image.", item.Title, folderNodeId);
            }

            if (!string.IsNullOrEmpty(stubVideoPath))
            {
                info.MediaSources = new List<MediaSourceInfo> { BuildMediaSource(itemId, stubVideoPath) };
            }

            return info;
        }

        private ChannelItemInfo BuildSeriesFolderItem(CachedChannelItem item, string folderNodeId)
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

            if (string.IsNullOrEmpty(item.PosterUrl))
            {
                logger.Warn("ChannelSync: Series item '{0}' in folder '{1}' has no PosterUrl — will show with no image.", item.Title, folderNodeId);
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

        // ---- MusicArtistAlbum: Artist (real top item) -> Album (synthetic,
        // "Album 1") -> Song (synthetic, tagged with Artist/AlbumArtist/Album
        // from the original fetched row). Same three-level shape as
        // Series/Season/Episode, same reasoning: the endpoint only returns
        // one flat row per artist, no real album/track-level data exists to
        // enumerate. ----

        private static ChannelItemInfo BuildArtistFolderItem(CachedChannelItem item, string folderNodeId)
        {
            var info = new ChannelItemInfo
            {
                Id = ArtistIdPrefix + folderNodeId + "::" + item.StableId,
                Name = item.Title,
                Overview = item.Overview,
                Type = ChannelItemType.Folder,
                FolderType = ChannelFolderType.MusicArtist,
                ImageUrl = item.PosterUrl,
                ForceUpdate = true
            };

            foreach (var kvp in item.ProviderIds)
            {
                info.ProviderIds[kvp.Key] = kvp.Value;
            }

            return info;
        }

        private ChannelItemResult BuildAlbumListing(string artistId)
        {
            var folderNodeId = ParseOwningFolderIdFromSyntheticId(artistId);
            var stableId = ParseStableIdFromPayload(artistId.Substring(ArtistIdPrefix.Length));
            var source = FindCachedItem(folderNodeId, stableId);

            var album = new ChannelItemInfo
            {
                Id = AlbumIdPrefix + artistId,
                Name = "Album 1",
                Type = ChannelItemType.Folder,
                FolderType = ChannelFolderType.MusicAlbum,
                ImageUrl = source?.PosterUrl,
                ForceUpdate = true
            };

            return new ChannelItemResult { Items = new List<ChannelItemInfo> { album }, TotalRecordCount = 1 };
        }

        private ChannelItemResult BuildSongListing(string albumId)
        {
            var folderNodeId = ParseOwningFolderIdFromSyntheticId(albumId);
            var stableId = ParseStableIdFromPayload(albumId.Substring(AlbumIdPrefix.Length + ArtistIdPrefix.Length));
            var source = FindCachedItem(folderNodeId, stableId);

            var stubVideoPath = folderNodeId == null
                ? string.Empty
                : cacheStore.Read(folderNodeId).StubVideoPath;

            if (string.IsNullOrEmpty(stubVideoPath))
            {
                stubVideoPath = ResolveDefaultStubPath();
            }

            var songId = SongIdPrefix + albumId;

            var song = new ChannelItemInfo
            {
                Id = songId,
                Name = "Track 1",
                Type = ChannelItemType.Media,
                MediaType = ChannelMediaType.Audio,
                ContentType = ChannelMediaContentType.Song,
                IndexNumber = 1,
                ParentIndexNumber = 1,
                Artists = string.IsNullOrEmpty(source?.Artist) ? null : new List<string> { source.Artist },
                AlbumArtists = string.IsNullOrEmpty(source?.AlbumArtist) ? null : new List<string> { source.AlbumArtist },
                //Album = source?.Album,
                ForceUpdate = true
            };

            if (!string.IsNullOrEmpty(stubVideoPath))
            {
                song.MediaSources = new List<MediaSourceInfo> { BuildMediaSource(songId, stubVideoPath) };
            }

            return new ChannelItemResult { Items = new List<ChannelItemInfo> { song }, TotalRecordCount = 1 };
        }

        // ---- PhotoAlbum: PhotoAlbum (real top item, real Emby class) ->
        // Photo (synthetic, single child — the row's own MediaFileUrl IS
        // the photo, no second synthetic layer needed). ----

        private static ChannelItemInfo BuildPhotoAlbumFolderItem(CachedChannelItem item, string folderNodeId)
        {
            var info = new ChannelItemInfo
            {
                Id = PhotoAlbumIdPrefix + folderNodeId + "::" + item.StableId,
                Name = item.Title,
                Overview = item.Overview,
                Type = ChannelItemType.Folder,
                FolderType = ChannelFolderType.PhotoAlbum,
                ImageUrl = item.PosterUrl,
                ForceUpdate = true
            };

            foreach (var kvp in item.ProviderIds)
            {
                info.ProviderIds[kvp.Key] = kvp.Value;
            }

            return info;
        }

        private ChannelItemResult BuildPhotoListing(string photoAlbumId)
        {
            var folderNodeId = ParseOwningFolderIdFromSyntheticId(photoAlbumId.Substring(PhotoAlbumIdPrefix.Length));
            var stableId = ParseStableIdFromPayload(photoAlbumId.Substring(PhotoAlbumIdPrefix.Length));
            var source = FindCachedItem(folderNodeId, stableId);

            // Falls back to PosterUrl if MediaFileUrl wasn't mapped —
            // common misconfiguration (or a source with only one image
            // concept, not a separate thumbnail-vs-full-photo distinction).
            // Confirmed crash otherwise: Photo.Path ends up null when
            // MediaSources is empty, and Emby's own PhotoProvider.HasChanged
            // throws ArgumentException on Path.GetFullPath(null) — not a
            // graceful failure, so this must be prevented here rather than
            // left to surface as a server error.
            var imageUrl = source != null && !string.IsNullOrEmpty(source.MediaFileUrl)
                ? source.MediaFileUrl
                : source?.PosterUrl;

            if (string.IsNullOrEmpty(imageUrl))
            {
                logger.Warn(
                    "ChannelSync: PhotoAlbum item '{0}' in folder '{1}' has neither MediaFileUrl nor PosterUrl — skipping its Photo child rather than creating one with no path.",
                    source?.Title, folderNodeId);
                return new ChannelItemResult { Items = new List<ChannelItemInfo>(), TotalRecordCount = 0 };
            }

            var photoId = PhotoIdPrefix + photoAlbumId;

            var photo = new ChannelItemInfo
            {
                Id = photoId,
                Name = source?.Title ?? "Photo 1",
                // Confirmed via live test (Evidence.md): this specific,
                // semantically-odd MediaType/ContentType combination is
                // what Emby's construction switch maps to a real Photo
                // BaseItem. Do not "correct" this to something more sensible
                // — it was checked, not guessed.
                Type = ChannelItemType.Media,
                MediaType = ChannelMediaType.Video,
                ContentType = ChannelMediaContentType.Trailer,
                ForceUpdate = true,
                MediaSources = new List<MediaSourceInfo> { BuildRemoteOrLocalMediaSource(photoId, imageUrl) }
            };

            return new ChannelItemResult { Items = new List<ChannelItemInfo> { photo }, TotalRecordCount = 1 };
        }

        // ---- GenericContainer: N admin-configured Container-typed levels,
        // then one configurable leaf. Level is carried in the id itself
        // since depth varies per schema. ----

        private static ChannelItemInfo BuildContainerFolderItem(CachedChannelItem item, string folderNodeId, int level)
        {
            var name = level == 0
                ? item.Title
                : (item.ContainerLevelNames != null && level - 1 < item.ContainerLevelNames.Count
                    ? item.ContainerLevelNames[level - 1]
                    : "Folder");

            return new ChannelItemInfo
            {
                Id = ContainerIdPrefix + level + "-" + folderNodeId + "::" + item.StableId,
                Name = name,
                Overview = level == 0 ? item.Overview : string.Empty,
                Type = ChannelItemType.Folder,
                FolderType = ChannelFolderType.Container,
                ImageUrl = level == 0 ? item.PosterUrl : null,
                ForceUpdate = true
            };
        }

        private ChannelItemResult BuildContainerLevelListing(string containerId)
        {
            var withoutPrefix = containerId.Substring(ContainerIdPrefix.Length);
            var dashIndex = withoutPrefix.IndexOf('-');
            var level = int.Parse(withoutPrefix.Substring(0, dashIndex));
            var payload = withoutPrefix.Substring(dashIndex + 1); // folderNodeId::stableId

            var folderNodeId = ParseFolderNodeIdFromPayload(payload);
            var stableId = ParseStableIdFromPayload(payload);
            var source = FindCachedItem(folderNodeId, stableId);

            if (source == null)
            {
                logger.Warn("ChannelSync: BuildContainerLevelListing could not find source item for '{0}' — returning empty.", containerId);
                return new ChannelItemResult { Items = new List<ChannelItemInfo>(), TotalRecordCount = 0 };
            }

            var nextLevel = level + 1;

            if (nextLevel < source.ContainerLevelCount)
            {
                var nextFolder = BuildContainerFolderItem(source, folderNodeId, nextLevel);
                return new ChannelItemResult { Items = new List<ChannelItemInfo> { nextFolder }, TotalRecordCount = 1 };
            }

            // Reached the configured depth — build the single leaf.
            var stubVideoPath = folderNodeId == null
                ? string.Empty
                : cacheStore.Read(folderNodeId).StubVideoPath;

            if (string.IsNullOrEmpty(stubVideoPath))
            {
                stubVideoPath = ResolveDefaultStubPath();
            }

            var leafId = "syncchannel-gcleaf-" + containerId;

            var leaf = new ChannelItemInfo
            {
                Id = leafId,
                Name = source.Title,
                Overview = source.Overview,
                Type = ChannelItemType.Media,
                MediaType = ToChannelMediaType(source.LeafMediaType),
                ContentType = ToChannelMediaContentType(source.LeafContentType),
                ForceUpdate = true
            };

            if (!string.IsNullOrEmpty(stubVideoPath))
            {
                leaf.MediaSources = new List<MediaSourceInfo> { BuildMediaSource(leafId, stubVideoPath) };
            }

            return new ChannelItemResult { Items = new List<ChannelItemInfo> { leaf }, TotalRecordCount = 1 };
        }

        // Explicit, not Enum.Parse-by-name — deliberately a hard mapping so
        // a mismatch fails to compile rather than silently misrouting at
        // runtime if either enum's members are ever reordered.
        private static ChannelMediaType ToChannelMediaType(LeafMediaType type)
        {
            switch (type)
            {
                case LeafMediaType.Audio: return ChannelMediaType.Audio;
                case LeafMediaType.Video:
                default: return ChannelMediaType.Video;
            }
        }

        private static ChannelMediaContentType ToChannelMediaContentType(LeafContentType type)
        {
            switch (type)
            {
                case LeafContentType.Clip: return ChannelMediaContentType.Clip;
                case LeafContentType.Podcast: return ChannelMediaContentType.Podcast;
                case LeafContentType.Trailer: return ChannelMediaContentType.Trailer;
                case LeafContentType.Episode: return ChannelMediaContentType.Episode;
                case LeafContentType.Song: return ChannelMediaContentType.Song;
                case LeafContentType.MovieExtra: return ChannelMediaContentType.MovieExtra;
                case LeafContentType.TvExtra: return ChannelMediaContentType.TvExtra;
                case LeafContentType.GameExtra: return ChannelMediaContentType.GameExtra;
                case LeafContentType.MusicVideo: return ChannelMediaContentType.MusicVideo;
                case LeafContentType.Movie:
                default: return ChannelMediaContentType.Movie;
            }
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

        // PhotoAlbum leaf only — the schema's MediaFileUrlField is typically
        // a remote image URL (same shape as PosterUrl), not a local stub
        // file, so this branches on that instead of always assuming File.
        private static MediaSourceInfo BuildRemoteOrLocalMediaSource(string itemId, string path)
        {
            var isRemote = path.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                           path.StartsWith("https://", StringComparison.OrdinalIgnoreCase);

            return new MediaSourceInfo
            {
                Id = itemId,
                Path = path,
                Protocol = isRemote ? MediaProtocol.Http : MediaProtocol.File,
                IsRemote = isRemote,
                SupportsDirectPlay = true,
                SupportsDirectStream = true,
                SupportsTranscoding = true,
                Name = "Coming Soon"
            };
        }

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