// Ported from ManageComingSoon.Channels.RadarrComingSoonChannel — see that
// project's Evidence.md for the confirmed platform behaviors this relies on
// (channel auto-registration, GetChannelImage called once at first-persist,
// IRequiresMediaInfoCallback as the real playback mechanism, TitleSlug as
// Radarr's stable identity, etc).
//
// Changed from the original: the TmdbService dependency has been dropped.
// It was only ever used by a commented-out poster-fallback code path that
// was never enabled — carrying that dependency into a standalone plugin
// would mean pulling in a whole extra HTTP-based service for genuinely dead
// code. If poster fallback via TMDB is wanted later, add the dependency
// back deliberately at that point.

namespace SyncChannel.Channels
{
    using SyncChannel.Configuration;
    using SyncChannel.Models;
    using SyncChannel.Services;
    using MediaBrowser.Common.Configuration;
    using MediaBrowser.Controller.Channels;
    using MediaBrowser.Controller.Drawing; // candidate namespace for DynamicImageResponse — see chat note
    using MediaBrowser.Model.Channels;
    using MediaBrowser.Model.Drawing;
    using MediaBrowser.Model.Dto; // DynamicImageResponse
    using MediaBrowser.Model.Entities;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.MediaInfo;
    using MediaBrowser.Model.Providers;
    using MediaBrowser.Model.Serialization;
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using System.Threading;
    using System.Threading.Tasks;
    using MediaBrowser.Controller.Providers;

    public class RadarrComingSoonChannel : IChannel, IRequiresMediaInfoCallback
    {
        private const string IdPrefix = "radarr-coming-soon-";
        private const string CacheFileName = "radarr-channel-cache.json";

        private const string DefaultStubResourceName = "SyncChannel.comingsoon.mp4";
        private const string DefaultStubCacheFileName = "radarr-stub-default.mp4";

        private static readonly string[] ValidVideoExtensions = { ".mp4", ".mkv", ".avi", ".mov" };

        private readonly IApplicationPaths appPaths;
        private readonly RadarrClient radarrClient;
        private readonly IJsonSerializer json;
        private readonly ILogger logger;

        public RadarrComingSoonChannel(
            IApplicationPaths appPaths,
            RadarrClient radarrClient,
            IJsonSerializer json,
            ILogger logger)
        {
            this.appPaths = appPaths;
            this.radarrClient = radarrClient;
            this.json = json;
            this.logger = logger;
        }

        public string Name => SyncChannelPlugin.Instance.Configuration.RadarrChannelName;

        public string Description => "Movies currently monitored in Radarr that have not yet been downloaded.";

        public ChannelParentalRating ParentalRating => ChannelParentalRating.GeneralAudience;

        public IEnumerable<ImageType> GetSupportedChannelImages()
        {
            this.logger.Info("ChannelSync: GetSupportedChannelImages called");
            return new List<ImageType> { ImageType.Primary };
        }

        public Task<DynamicImageResponse> GetChannelImage(ImageType type, CancellationToken cancellationToken)
        {
            var pluginType = typeof(SyncChannelPlugin);
            var resourceName = pluginType.Namespace + ".ComingSoonChannel2.png";
            var stream = pluginType.Assembly.GetManifestResourceStream(resourceName);

            if (stream == null)
            {
                this.logger.Info("ChannelSync: GetChannelImage FAILED to load resource '{0}' from assembly '{1}'", resourceName, pluginType.Assembly.FullName);
            }
            else
            {
                this.logger.Info("ChannelSync: GetChannelImage loaded resource '{0}' ({1} bytes)", resourceName, stream.Length);
            }

            return Task.FromResult(new DynamicImageResponse
            {
                Format = ImageFormat.Png,
                Protocol = MediaProtocol.File,
                Stream = stream
            });
        }

        public Task<IEnumerable<MediaSourceInfo>> GetChannelItemMediaInfo(string id, CancellationToken cancellationToken)
        {
            var config = SyncChannelPlugin.Instance.Configuration;

            string stubVideoPath = config.RadarrSyncMode == RadarrSyncMode.Cached
                ? ReadCache().StubVideoPath
                : ResolveStubVideoPath(config, appPaths, logger);

            logger.Info(
                "ChannelSync: GetChannelItemMediaInfo called for Id='{0}'. Resolved stubVideoPath='{1}', Exists={2}.",
                id, stubVideoPath, !string.IsNullOrEmpty(stubVideoPath) && File.Exists(stubVideoPath));

            if (string.IsNullOrEmpty(stubVideoPath) || !File.Exists(stubVideoPath))
            {
                logger.Warn("ChannelSync: GetChannelItemMediaInfo returning empty list for Id='{0}' — no valid stub path.", id);
                return Task.FromResult<IEnumerable<MediaSourceInfo>>(Array.Empty<MediaSourceInfo>());
            }

            var source = BuildMediaSource(id, stubVideoPath);

            logger.Info(
                "ChannelSync: GetChannelItemMediaInfo returning source — Id='{0}', Path='{1}', Protocol={2}, Container='{3}', SupportsDirectPlay={4}.",
                source.Id, source.Path, source.Protocol, source.Container, source.SupportsDirectPlay);

            return Task.FromResult<IEnumerable<MediaSourceInfo>>(new List<MediaSourceInfo> { source });
        }

        public async Task<ChannelItemResult> GetChannelItems(
            InternalChannelItemQuery query,
            CancellationToken cancellationToken)
        {
            var config = SyncChannelPlugin.Instance.Configuration;

            if (!config.RadarrEnabled)
            {
                return new ChannelItemResult
                {
                    Items = new List<ChannelItemInfo>(),
                    TotalRecordCount = 0
                };
            }

            List<RadarrChannelCacheItem> sourceItems;
            string stubVideoPath;

            if (config.RadarrSyncMode == RadarrSyncMode.Live)
            {
                logger.Info("ChannelSync: [LIVE MODE] GetChannelItems invoked — querying Radarr directly (caller-agnostic: UI browse, RefreshInternetChannels, or our own task).");

                var liveMovies = await radarrClient
                    .GetComingSoonMoviesAsync(config, cancellationToken)
                    .ConfigureAwait(false);

                logger.Info("ChannelSync: [LIVE MODE] Radarr live call returned {0} item(s). (-1 indicates a failed/null call.)", liveMovies?.Count ?? -1);

                if (liveMovies == null)
                {
                    // Radarr call failed. Must NOT be treated as "nothing
                    // qualifies" — fall back to the last known-good cache
                    // instead of returning an empty list.
                    logger.Warn("ChannelSync: Radarr live call failed; showing last known state instead of an empty channel.");
                    var cache = ReadCache();
                    sourceItems = cache.Items;
                    stubVideoPath = cache.StubVideoPath;
                }
                else
                {
                    sourceItems = liveMovies.Select(ToCacheItem).ToList();
                    // Live mode has no scheduled task pre-resolving this, so
                    // resolve directly. Cheap in the common case (File.Exists
                    // short-circuit) — only does real I/O the first time or
                    // after the configured path changes.
                    stubVideoPath = ResolveStubVideoPath(config, appPaths, logger);
                }
            }
            else
            {
                var cache = ReadCache();
                sourceItems = cache.Items;
                stubVideoPath = cache.StubVideoPath;
            }

            var channelItems = new List<ChannelItemInfo>(sourceItems.Count);
            foreach (var item in sourceItems)
            {
                var info = ToChannelItemInfo(item, stubVideoPath);
                if (info != null)
                {
                    channelItems.Add(info);
                }
            }

            logger.Info("ChannelSync: GetChannelItems ({0} mode) returning {1} item(s). stubVideoPath='{2}'.", config.RadarrSyncMode, channelItems.Count, stubVideoPath);

            foreach (var ci in channelItems)
            {
                var sourcesDesc = ci.MediaSources == null || ci.MediaSources.Count == 0
                    ? "(none)"
                    : string.Join("; ", ci.MediaSources.Select(s => string.Format(
                        "Path='{0}', Protocol={1}, Container='{2}'", s.Path, s.Protocol, s.Container)));

                logger.Info(
                    "ChannelSync:   Item Id='{0}', Name='{1}', MediaSources=[{2}].",
                    ci.Id, ci.Name, sourcesDesc);
            }

            return new ChannelItemResult
            {
                Items = channelItems,
                TotalRecordCount = channelItems.Count
            };
        }

        // -----------------------------------------------------------------
        // ISupportsDelete — deliberately NOT implemented. Confirmed (see the
        // original project's Evidence.md) that normal add/remove sync works
        // purely off implicit reconciliation via GetChannelItems; explicit
        // delete is only relevant to a user-initiated delete from Emby's own
        // UI, which this plugin doesn't currently expose a use case for.
        // -----------------------------------------------------------------

        // -----------------------------------------------------------------
        // Cache read/write — shared with RadarrChannelSyncTask, which is the
        // only writer in Cached mode.
        // -----------------------------------------------------------------

        internal RadarrChannelCache ReadCache()
        {
            var path = GetCachePath();

            if (!File.Exists(path))
            {
                return new RadarrChannelCache { LastSyncSucceeded = false };
            }

            try
            {
                var text = File.ReadAllText(path);
                return json.DeserializeFromString<RadarrChannelCache>(text)
                    ?? new RadarrChannelCache { LastSyncSucceeded = false };
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Failed to read Radarr channel cache at {0}", ex, path);
                return new RadarrChannelCache { LastSyncSucceeded = false };
            }
        }

        internal void WriteCache(RadarrChannelCache cache)
        {
            var path = GetCachePath();
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);

            var text = json.SerializeToString(cache);
            File.WriteAllText(path, text);
        }

        private string GetCachePath()
        {
            return Path.Combine(appPaths.DataPath, "channel-sync", CacheFileName);
        }

        // -----------------------------------------------------------------
        // Stub video resolution — shared logic, called by both the
        // scheduled task (Cached mode: resolved once per run, stored in
        // cache) and this class directly (Live mode: no cache to rely on).
        // -----------------------------------------------------------------

        internal static string ResolveStubVideoPath(PluginConfiguration config, IApplicationPaths appPaths, ILogger logger)
        {
            var configuredPath = (config.RadarrStubVideoPath ?? string.Empty).Trim();

            if (!string.IsNullOrEmpty(configuredPath))
            {
                var ext = Path.GetExtension(configuredPath).ToLowerInvariant();
                bool validExt = ValidVideoExtensions.Any(v => string.Equals(v, ext, StringComparison.OrdinalIgnoreCase));

                if (validExt && File.Exists(configuredPath))
                {
                    return configuredPath;
                }

                logger.Warn(
                    "ChannelSync: Configured RadarrStubVideoPath '{0}' is invalid or missing — falling back to the default placeholder.",
                    configuredPath);
            }

            var defaultPath = Path.Combine(appPaths.DataPath, "channel-sync", DefaultStubCacheFileName);

            if (File.Exists(defaultPath))
            {
                return defaultPath;
            }

            try
            {
                var dir = Path.GetDirectoryName(defaultPath);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                    Directory.CreateDirectory(dir);

                var asm = typeof(SyncChannelPlugin).Assembly;
                using (var resourceStream = asm.GetManifestResourceStream(DefaultStubResourceName))
                {
                    if (resourceStream == null)
                    {
                        logger.Warn("ChannelSync: Embedded default stub resource '{0}' not found — channel items will have no playable source.", DefaultStubResourceName);
                        return string.Empty;
                    }

                    using (var fileStream = File.Create(defaultPath))
                    {
                        resourceStream.CopyTo(fileStream);
                    }
                }

                logger.Info("ChannelSync: Extracted default Radarr stub video to {0}.", defaultPath);
                return defaultPath;
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Failed to extract default Radarr stub video", ex);
                return string.Empty;
            }
        }

        // -----------------------------------------------------------------
        // Mapping helpers
        // -----------------------------------------------------------------

        // TitleSlug is Radarr's assumed permanent, never-changing primary
        // identity for a movie. Item identity is keyed off it rather than
        // TmdbId so that stale ProviderIds (which Emby only writes once, at
        // first item creation) can never persist under a "same" item — if
        // the slug ever changed, the old item id would vanish from
        // GetChannelItems and a fresh item would be created instead.
        private static string BuildItemId(string titleSlug) => IdPrefix + titleSlug;

        private static RadarrChannelCacheItem ToCacheItem(RadarrMovie movie)
        {
            string posterUrl = movie.Images?
                .FirstOrDefault(i => string.Equals(i.CoverType, "poster", StringComparison.OrdinalIgnoreCase))?
                .RemoteUrl;

            return new RadarrChannelCacheItem
            {
                RadarrId = movie.Id,
                TmdbId = movie.TmdbId,
                ImdbId = movie.ImdbId,
                TitleSlug = movie.TitleSlug,
                Title = movie.Title,
                OriginalTitle = movie.OriginalTitle,
                Year = movie.Year,
                Overview = movie.Overview,
                PosterUrl = posterUrl
            };
        }

        private ChannelItemInfo ToChannelItemInfo(RadarrChannelCacheItem item, string stubVideoPath)
        {
            // TitleSlug is treated as Radarr's permanent primary identity for
            // this channel item. If it's ever missing, we can't safely key
            // the item's identity — drop it rather than risk
            // duplicate/orphaned channel entries under some other key.
            if (string.IsNullOrEmpty(item.TitleSlug))
            {
                logger.Warn(
                    "ChannelSync: Radarr item '{0}' (TmdbId={1}) has no TitleSlug — dropping from channel.",
                    item.Title, item.TmdbId);
                return null;
            }

            var itemId = BuildItemId(item.TitleSlug);

            var info = new ChannelItemInfo
            {
                Id = itemId,
                Name = item.Title,
                OriginalTitle = item.OriginalTitle,
                Overview = item.Overview,
                Type = ChannelItemType.Media,
                MediaType = ChannelMediaType.Video,
                ContentType = ChannelMediaContentType.Movie,
                ProductionYear = item.Year > 0 ? item.Year : (int?)null,
                ImageUrl = item.PosterUrl
            };

            if (item.TmdbId > 0)
                info.ProviderIds["Tmdb"] = item.TmdbId.ToString();
            if (!string.IsNullOrEmpty(item.ImdbId))
                info.ProviderIds["Imdb"] = item.ImdbId;

            // Surfaced in Emby's UI via RadarrExternalId (IExternalId), whose
            // UrlFormatString builds a clickable link back to this movie's
            // page in the configured Radarr instance.
            info.ProviderIds["RadarrId"] = item.TitleSlug;

            // Populated here too as a secondary hint, though
            // GetChannelItemMediaInfo is the confirmed actual mechanism Emby
            // uses at playback time.
            if (!string.IsNullOrEmpty(stubVideoPath))
            {
                info.MediaSources = new List<MediaSourceInfo> { BuildMediaSource(itemId, stubVideoPath) };
            }

            return info;
        }

        private static MediaSourceInfo BuildMediaSource(string itemId, string stubVideoPath)
        {
            return new MediaSourceInfo
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
        }
    }
}
