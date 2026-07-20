namespace SyncChannel.ScheduledTasks
{
    using SyncChannel.Channels;
    using SyncChannel.Configuration;
    using SyncChannel.Fetching;
    using SyncChannel.Models;
    using SyncChannel.Services;
    using MediaBrowser.Controller.Channels;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.Tasks;
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Threading;
    using System.Threading.Tasks;

    /// <summary>
    /// Walks the admin-defined folder tree depth-first. For each node, runs
    /// every enabled FetchRuleInstance through the provider registry and
    /// writes the merged results to that node's own cache file. One
    /// GetChannelItems call at browse/refresh time then only ever needs to
    /// read the single cache file for the folder being viewed — see
    /// SyncFolderChannel.GetChannelItems.
    ///
    /// A failed fetch (provider returns null) leaves that node's existing
    /// cache untouched for that provider's contribution — same "null means
    /// skip, never zero" contract already established for the flat
    /// Radarr channel in Evidence.md, now per-fetch-instance rather than
    /// per-whole-channel.
    /// </summary>
    public class FolderTreeSyncTask : IScheduledTask
    {
        private const string RefreshChannelsTaskKey = "RefreshInternetChannels";
        private const string RefreshChannelsTaskName = "Refresh Internet Channels";

        private readonly FolderTreeStore treeStore;
        private readonly FolderCacheStore cacheStore;
        private readonly FetchProviderRegistry registry;
        private readonly IChannelManager channelManager;
        private readonly ITaskManager taskManager;
        private readonly ILogger logger;

        public FolderTreeSyncTask(
            FolderTreeStore treeStore,
            FolderCacheStore cacheStore,
            FetchProviderRegistry registry,
            IChannelManager channelManager,
            ITaskManager taskManager,
            ILogger logger)
        {
            this.treeStore = treeStore;
            this.cacheStore = cacheStore;
            this.registry = registry;
            this.channelManager = channelManager;
            this.taskManager = taskManager;
            this.logger = logger;
        }

        public string Name => "Sync Coming Soon Folder Tree";

        public string Key => "ChannelSync-FolderTreeSync";

        public string Description =>
            "Runs every configured fetch (Radarr, Sonarr, etc) for every folder in the admin-defined folder tree, updates each folder's cache, and persists the results into Emby.";

        public string Category => "Channel Sync";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            yield return new TaskTriggerInfo
            {
                Type = TaskTriggerInfo.TriggerInterval,
                IntervalTicks = TimeSpan.FromMinutes(15).Ticks
            };
        }

        public async Task Execute(CancellationToken cancellationToken, IProgress<double> progress)
        {
            var tree = treeStore.Load();

            var allFolderIds = new List<string>();
            await SyncNode(tree.RootFolder, allFolderIds, cancellationToken).ConfigureAwait(false);

            // Prune cache files for folders that no longer exist (e.g. an
            // admin removed a subfolder since the last run) — harmless if
            // skipped, but keeps disk state honest.
            cacheStore.DeleteOrphans(allFolderIds);

            progress.Report(50);

            var channel = channelManager.GetChannel<SyncFolderChannel>();
            if (channel == null)
            {
                logger.Warn("ChannelSync: SyncFolderChannel is not registered with ChannelManager yet — skipping refresh this run.");
                return;
            }

            try
            {
                await channelManager
                    .RefreshChannelContent(channel, maxRefreshLevel: 8, restrictTopLevelFolderId: null, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: RefreshChannelContent failed for SyncFolderChannel", ex);
            }

            progress.Report(80);

            await TriggerRefreshInternetChannels().ConfigureAwait(false);

            progress.Report(100);
        }

        private async Task SyncNode(FolderNode node, List<string> allFolderIds, CancellationToken cancellationToken)
        {
            allFolderIds.Add(node.Id);

            var existingCache = cacheStore.Read(node.Id);
            var mergedItems = new List<CachedChannelItem>();
            bool anyFetchAttempted = false;
            bool anyFetchSucceeded = false;

            foreach (var fetch in node.Fetches.Where(f => f.Enabled))
            {
                anyFetchAttempted = true;
                var provider = registry.Get(fetch.ProviderKey);

                if (provider == null)
                {
                    logger.Warn(
                        "ChannelSync: Folder '{0}' fetch '{1}' references unknown provider '{2}' — skipping.",
                        node.DisplayName, fetch.DisplayLabel, fetch.ProviderKey);
                    continue;
                }

                IReadOnlyList<FetchedItem> results;
                try
                {
                    results = await provider.FetchAsync(fetch.Settings, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    logger.ErrorException(
                        "ChannelSync: Fetch '{0}' ({1}) in folder '{2}' threw — treating as failed, leaving prior results for this fetch untouched",
                        ex, fetch.DisplayLabel, fetch.ProviderKey, node.DisplayName);
                    results = null;
                }

                if (results == null)
                {
                    // This specific fetch failed — carry forward whatever
                    // this provider previously contributed to this folder,
                    // rather than dropping it (null must never mean "zero").
                    var priorFromThisProvider = existingCache.Items
                        .Where(i => string.Equals(i.ProviderKey, fetch.ProviderKey, StringComparison.OrdinalIgnoreCase));
                    mergedItems.AddRange(priorFromThisProvider);
                    continue;
                }

                anyFetchSucceeded = true;
                mergedItems.AddRange(results.Select(r => ToCache(r, fetch.ProviderKey)));
            }

            if (anyFetchAttempted)
            {
                var newCache = new FolderCache
                {
                    Items = mergedItems,
                    LastSyncSucceeded = anyFetchSucceeded,
                    LastSyncUtc = DateTimeOffset.UtcNow,
                    StubVideoPath = existingCache.StubVideoPath // stub resolution owned elsewhere; preserved as-is here
                };
                cacheStore.Write(node.Id, newCache);

                logger.Info(
                    "ChannelSync: Folder '{0}' synced — {1} item(s) across {2} fetch(es).",
                    node.DisplayName, mergedItems.Count, node.Fetches.Count(f => f.Enabled));
            }

            foreach (var child in node.Children)
            {
                await SyncNode(child, allFolderIds, cancellationToken).ConfigureAwait(false);
            }
        }

        private static CachedChannelItem ToCache(FetchedItem item, string providerKey) => new CachedChannelItem
        {
            ProviderKey = providerKey,
            StableId = item.StableId,
            Title = item.Title,
            OriginalTitle = item.OriginalTitle,
            Year = item.Year,
            Overview = item.Overview,
            PosterUrl = item.PosterUrl,
            ProviderIds = item.ProviderIds
        };

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
                    logger.Warn("ChannelSync: Could not find the built-in channel-refresh task — folder tree changes will only appear once it next runs on its own schedule.");
                    return;
                }

                await taskManager.Execute(refreshWorker, new TaskOptions()).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Failed to trigger the built-in channel-refresh task", ex);
            }
        }
    }
}
