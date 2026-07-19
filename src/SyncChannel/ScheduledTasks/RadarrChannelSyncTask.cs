namespace SyncChannel.ScheduledTasks
{
    using SyncChannel.Channels;
    using SyncChannel.Configuration;
    using SyncChannel.Models;
    using SyncChannel.Services;
    using MediaBrowser.Common.Configuration;
    using MediaBrowser.Controller.Channels;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.Tasks;
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Threading;
    using System.Threading.Tasks;

    public class RadarrChannelSyncTask : IScheduledTask
    {
        private const string RefreshChannelsTaskKey = "RefreshInternetChannels";
        private const string RefreshChannelsTaskName = "Refresh Internet Channels";

        private readonly RadarrClient radarrClient;
        private readonly IChannelManager channelManager;
        private readonly ITaskManager taskManager;
        private readonly IApplicationPaths appPaths;
        private readonly RadarrChannelIdentityReconciler reconciler;
        private readonly ILogger logger;

        public RadarrChannelSyncTask(
            RadarrClient radarrClient,
            IChannelManager channelManager,
            ITaskManager taskManager,
            IApplicationPaths appPaths,
            RadarrChannelIdentityReconciler reconciler,
            ILogger logger)
        {
            this.radarrClient = radarrClient;
            this.channelManager = channelManager;
            this.taskManager = taskManager;
            this.appPaths = appPaths;
            this.reconciler = reconciler;
            this.logger = logger;
        }

        public string Name => "Sync Radarr Coming Soon Channel";

        public string Key => "ChannelSync-RadarrChannelSync";

        public string Description =>
            "Queries Radarr for monitored, not-yet-downloaded movies, updates the Radarr Coming Soon channel's cache (Cached mode only), ensures the placeholder video exists, and persists changes into Emby. Runs whenever Radarr integration is enabled, regardless of sync mode.";

        public string Category => "Channel Sync";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            var config = SyncChannelPlugin.Instance.Configuration;
            var minutes = Math.Max(1, config.RadarrRefreshMinutes);

            yield return new TaskTriggerInfo
            {
                Type = TaskTriggerInfo.TriggerInterval,
                IntervalTicks = TimeSpan.FromMinutes(minutes).Ticks
            };
        }

        public async Task Execute(CancellationToken cancellationToken, IProgress<double> progress)
        {
            var config = SyncChannelPlugin.Instance.Configuration;

            if (!config.RadarrEnabled)
            {
                logger.Info("ChannelSync: Radarr sync skipped — Radarr integration disabled.");
                return;
            }

            if (config.RadarrSyncMode == RadarrSyncMode.Cached)
            {
                await RunCachedSync(config, cancellationToken).ConfigureAwait(false);
            }
            else
            {
                logger.Info("ChannelSync: [LIVE MODE] Sync task run — cache untouched; GetChannelItems will query Radarr directly when RefreshInternetChannels invokes it below.");
            }

            // Unconditional regardless of sync mode — this is what actually
            // persists whatever GetChannelItems currently returns into
            // Emby's DB, and keeps the Channel BaseItem's tag/image correct.
            // In Live mode, triggering RefreshInternetChannels is what
            // causes the live Radarr call to happen (via GetChannelItems),
            // so this section is not optional there.

            var channel = channelManager.GetChannel<RadarrComingSoonChannel>();
            if (channel == null)
            {
                logger.Warn("ChannelSync: Radarr Coming Soon channel is not registered with ChannelManager yet — skipping refresh/reconcile this run.");
                return;
            }

            try
            {
                await channelManager
                    .RefreshChannelContent(channel, maxRefreshLevel: 0, restrictTopLevelFolderId: null, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                logger.ErrorException(
                    "ChannelSync: RefreshChannelContent failed (this only affects how soon the change is reflected)",
                    ex);
            }

            await TriggerRefreshInternetChannels().ConfigureAwait(false);

            reconciler.Reconcile(config);
        }

        private async Task RunCachedSync(PluginConfiguration config, CancellationToken cancellationToken)
        {
            var movies = await radarrClient
                .GetComingSoonMoviesAsync(config, cancellationToken)
                .ConfigureAwait(false);

            if (movies == null)
            {
                logger.Warn("ChannelSync: Radarr sync failed — leaving cache untouched.");
                return;
            }

            var channel = channelManager.GetChannel<RadarrComingSoonChannel>();
            if (channel == null)
            {
                logger.Warn("ChannelSync: Radarr Coming Soon channel is not registered with ChannelManager yet — skipping cache update this run.");
                return;
            }

            var cache = channel.ReadCache();

            var newItems = movies
                .Select(m => new RadarrChannelCacheItem
                {
                    RadarrId = m.Id,
                    TmdbId = m.TmdbId,
                    ImdbId = m.ImdbId,
                    TitleSlug = m.TitleSlug,
                    Title = m.Title,
                    OriginalTitle = m.OriginalTitle,
                    Year = m.Year,
                    Overview = m.Overview,
                    PosterUrl = m.Images?
                        .FirstOrDefault(i => string.Equals(i.CoverType, "poster", StringComparison.OrdinalIgnoreCase))?
                        .RemoteUrl
                })
                .ToList();

            var oldSlugs = new HashSet<string>(cache.Items.Select(i => i.TitleSlug));
            var newSlugs = new HashSet<string>(newItems.Select(i => i.TitleSlug));

            var addedSlugs = newSlugs.Except(oldSlugs).ToList();
            var removedSlugs = oldSlugs.Except(newSlugs).ToList();

            logger.Info(
                "ChannelSync: Radarr sync diff — {0} added, {1} removed, {2} unchanged, {3} total.",
                addedSlugs.Count, removedSlugs.Count, newSlugs.Intersect(oldSlugs).Count(), newSlugs.Count);

            foreach (var item in newItems)
            {
                logger.Debug(
                    "ChannelSync: Sync item — TitleSlug='{0}', TmdbId={1}, Title='{2}'.",
                    item.TitleSlug, item.TmdbId, item.Title);
            }

            var stubVideoPath = RadarrComingSoonChannel.ResolveStubVideoPath(config, appPaths, logger);

            cache.Items = newItems;
            cache.StubVideoPath = stubVideoPath;
            cache.LastSyncSucceeded = true;
            cache.LastSyncUtc = DateTimeOffset.UtcNow;
            channel.WriteCache(cache);
        }

        private async Task TriggerRefreshInternetChannels()
        {
            try
            {
                var refreshWorker = taskManager.ScheduledTasks
                    .FirstOrDefault(w => string.Equals(w.ScheduledTask?.Key, RefreshChannelsTaskKey, StringComparison.OrdinalIgnoreCase))
                    ?? taskManager.ScheduledTasks
                        .FirstOrDefault(w => string.Equals(w.Name, RefreshChannelsTaskName, StringComparison.OrdinalIgnoreCase));

                if (refreshWorker == null)
                {
                    logger.Warn(
                        "ChannelSync: Could not find the built-in channel-refresh task (Key='{0}' / Name='{1}') — items will only be persisted whenever that task next runs on its own schedule.",
                        RefreshChannelsTaskKey, RefreshChannelsTaskName);
                    return;
                }

                await taskManager.Execute(refreshWorker, new TaskOptions()).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                logger.ErrorException(
                    "ChannelSync: Failed to trigger the built-in channel-refresh task — items may not be persisted until it next runs on its own schedule",
                    ex);
            }
        }
    }
}
