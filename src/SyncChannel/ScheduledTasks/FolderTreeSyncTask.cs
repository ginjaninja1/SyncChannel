namespace SyncChannel.ScheduledTasks
{
    using MediaBrowser.Controller.Channels;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.Tasks;
    using SyncChannel.Channels;
    using SyncChannel.Configuration;
    using SyncChannel.Fetching;
    using SyncChannel.Models;
    using SyncChannel.Rules;
    using SyncChannel.Services;
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Threading;
    using System.Threading.Tasks;

    public class FolderTreeSyncTask : IScheduledTask
    {
        private const string RefreshChannelsTaskKey = "RefreshInternetChannels";
        private const string RefreshChannelsTaskName = "Refresh Internet Channels";

        private readonly FolderTreeStore treeStore;
        private readonly FolderCacheStore cacheStore;
        private readonly ConnectionsStore connectionsStore;
        private readonly EndpointSchemaStore schemaStore;
        private readonly RuleSetStore ruleSetStore;
        private readonly HttpFetchProvider fetchProvider;
        private readonly Services.LastResponseCacheStore lastResponseStore;
        private readonly IChannelManager channelManager;
        private readonly ITaskManager taskManager;
        private readonly ILogger logger;
        private readonly ChannelIdentityReconciler reconciler;
        private readonly FolderCollageBuilder collageBuilder;

        public FolderTreeSyncTask(
    FolderTreeStore treeStore,
    FolderCacheStore cacheStore,
    ConnectionsStore connectionsStore,
    EndpointSchemaStore schemaStore,
    RuleSetStore ruleSetStore,
    HttpFetchProvider fetchProvider,
    Services.LastResponseCacheStore lastResponseStore,
    IChannelManager channelManager,
    ITaskManager taskManager,
    ChannelIdentityReconciler reconciler,
    FolderCollageBuilder collageBuilder,
    ILogger logger)
        {
            this.treeStore = treeStore;
            this.cacheStore = cacheStore;
            this.connectionsStore = connectionsStore;
            this.schemaStore = schemaStore;
            this.ruleSetStore = ruleSetStore;
            this.fetchProvider = fetchProvider;
            this.lastResponseStore = lastResponseStore;
            this.channelManager = channelManager;
            this.taskManager = taskManager;
            this.reconciler = reconciler;
            this.collageBuilder = collageBuilder;
            this.logger = logger;
        }

        public string Name => "Sync Coming Soon Folder Tree";
        public string Key => "ChannelSync-FolderTreeSync";
        public string Description =>
            "Runs every configured fetch for every folder in the admin-defined folder tree, updates each folder's cache, and persists the results into Emby. Change the schedule here, in Scheduled Tasks — there is no separate interval setting in plugin config.";
        public string Category => "GinjaNinja Tools";

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
            var connections = connectionsStore.Load().Connections.ToDictionary(c => c.Id, c => c, StringComparer.OrdinalIgnoreCase);
            var schemas = schemaStore.Load().Schemas.ToDictionary(s => s.Id, s => s, StringComparer.OrdinalIgnoreCase);
            var ruleSets = ruleSetStore.Load().RuleSets.ToDictionary(r => r.Id, r => r, StringComparer.OrdinalIgnoreCase);

            var allFolderIds = new List<string>();
            // Collects every node that actually had a fetch attempted this
            // pass, so collage building can happen AFTER the BaseItems for
            // any brand-new folders exist (see SyncedNodes comment below).
            var syncedNodes = new List<(FolderNode Node, FolderCache Cache)>();

            await SyncNode(tree.RootFolder, connections, schemas, ruleSets, allFolderIds, syncedNodes, cancellationToken).ConfigureAwait(false);

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
                await channelManager.RefreshChannelContent(channel, 8, null, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: RefreshChannelContent failed", ex);
            }

            progress.Report(80);
            await TriggerRefreshInternetChannels().ConfigureAwait(false);
            progress.Report(100);
            reconciler.Reconcile(SyncChannelPlugin.Instance.Configuration);

            // Collage building deliberately runs LAST, after
            // RefreshChannelContent + "Refresh Internet Channels" have had a
            // chance to persist BaseItems for any folder synced for the very
            // first time this pass. Doing this earlier (immediately after
            // each folder's cache write) meant a brand-new subfolder's
            // ExternalId lookup always missed on its first sync — the
            // collage would only appear on the NEXT scheduled run once the
            // BaseItem already existed from the prior pass's refresh.
            await BuildCollagesFor(syncedNodes, cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        /// Public, narrower entry point used by ChannelSyncApiSurface for a
        /// responsive save: re-syncs only the folders that use a given rule
        /// set, then triggers the same reconciliation. Bounded work — not
        /// a full tree walk — per the "cheap path" design agreed with the
        /// operator.
        /// </summary>
        public async Task SyncFoldersAndRefresh(IEnumerable<string> folderIds, CancellationToken cancellationToken)
        {
            var tree = treeStore.Load();
            var connections = connectionsStore.Load().Connections.ToDictionary(c => c.Id, c => c, StringComparer.OrdinalIgnoreCase);
            var schemas = schemaStore.Load().Schemas.ToDictionary(s => s.Id, s => s, StringComparer.OrdinalIgnoreCase);
            var ruleSets = ruleSetStore.Load().RuleSets.ToDictionary(r => r.Id, r => r, StringComparer.OrdinalIgnoreCase);

            var syncedNodes = new List<(FolderNode Node, FolderCache Cache)>();

            foreach (var folderId in folderIds)
            {
                var node = FolderTreeStore.FindNode(tree.RootFolder, folderId);
                if (node != null)
                {
                    var cache = await SyncSingleNode(node, connections, schemas, ruleSets, cancellationToken).ConfigureAwait(false);
                    if (cache != null)
                    {
                        syncedNodes.Add((node, cache));
                    }
                }
            }

            var channel = channelManager.GetChannel<SyncFolderChannel>();
            if (channel != null)
            {
                try { await channelManager.RefreshChannelContent(channel, 8, null, cancellationToken).ConfigureAwait(false); }
                catch (Exception ex) { logger.ErrorException("ChannelSync: RefreshChannelContent failed (responsive save)", ex); }
            }

            await TriggerRefreshInternetChannels().ConfigureAwait(false);

            // Same ordering fix as the main Execute() path — see comment there.
            await BuildCollagesFor(syncedNodes, cancellationToken).ConfigureAwait(false);
        }

        private async Task BuildCollagesFor(List<(FolderNode Node, FolderCache Cache)> syncedNodes, CancellationToken cancellationToken)
        {
            foreach (var (node, cache) in syncedNodes)
            {
                await collageBuilder.BuildIfNeeded(node, cache, cancellationToken).ConfigureAwait(false);
            }
        }

        private async Task SyncNode(
            FolderNode node,
            Dictionary<string, ConnectionEntry> connections,
            Dictionary<string, EndpointSchema> schemas,
            Dictionary<string, RuleSet> ruleSets,
            List<string> allFolderIds,
            List<(FolderNode Node, FolderCache Cache)> syncedNodes,
            CancellationToken cancellationToken)
        {
            allFolderIds.Add(node.Id);

            var cache = await SyncSingleNode(node, connections, schemas, ruleSets, cancellationToken).ConfigureAwait(false);
            if (cache != null)
            {
                syncedNodes.Add((node, cache));
            }

            foreach (var child in node.Children)
            {
                await SyncNode(child, connections, schemas, ruleSets, allFolderIds, syncedNodes, cancellationToken).ConfigureAwait(false);
            }
        }

        /// <summary>
        /// Fetches + writes this node's cache. Returns the new FolderCache if
        /// a fetch was actually attempted (anyAttempted), so the caller can
        /// decide when to build the folder's collage — NOT called from here
        /// anymore, since the folder's BaseItem may not exist yet on a
        /// first-ever sync. Returns null if nothing was attempted.
        /// </summary>
        private async Task<FolderCache> SyncSingleNode(
            FolderNode node,
            Dictionary<string, ConnectionEntry> connections,
            Dictionary<string, EndpointSchema> schemas,
            Dictionary<string, RuleSet> ruleSets,
            CancellationToken cancellationToken)
        {
            var existingCache = cacheStore.Read(node.Id);
            var priorByStableId = existingCache.Items
                .Where(i => !string.IsNullOrEmpty(i.StableId))
                .GroupBy(i => i.StableId, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
            var mergedItems = new List<CachedChannelItem>();
            bool anyAttempted = false, anySucceeded = false;

            foreach (var fetch in node.Fetches.Where(f => f.Enabled))
            {
                anyAttempted = true;

                if (!connections.TryGetValue(fetch.ConnectionId, out var connection) ||
                    !schemas.TryGetValue(fetch.EndpointSchemaId, out var schema) ||
                    !ruleSets.TryGetValue(fetch.RuleSetId, out var ruleSet))
                {
                    logger.Warn("ChannelSync: Folder '{0}' fetch '{1}' references a missing connection/schema/rule set — skipping.", node.DisplayName, fetch.DisplayLabel);
                    continue;
                }

                var rawJson = await fetchProvider.FetchRawAsync(connection, schema, cancellationToken).ConfigureAwait(false);

                if (rawJson == null)
                {
                    mergedItems.AddRange(existingCache.Items.Where(i => string.Equals(i.ProviderKey, fetch.Id, StringComparison.OrdinalIgnoreCase)));
                    continue;
                }

                lastResponseStore.Write(connection.Id, schema.Id, rawJson);

                var results = fetchProvider.EvaluateAndMap(rawJson, connection, schema, ruleSet.Root);

                if (results == null)
                {
                    mergedItems.AddRange(existingCache.Items.Where(i => string.Equals(i.ProviderKey, fetch.Id, StringComparison.OrdinalIgnoreCase)));
                    continue;
                }

                anySucceeded = true;
                mergedItems.AddRange(results.Select(r => ToCache(r, fetch.Id, schema.ObjectKind, priorByStableId)));
            }

            if (!anyAttempted)
            {
                return null;
            }

            var newCache = new FolderCache
            {
                Items = mergedItems,
                LastSyncSucceeded = anySucceeded,
                LastSyncUtc = DateTimeOffset.UtcNow,
                StubVideoPath = existingCache.StubVideoPath,
                LastCollageStableIds = existingCache.LastCollageStableIds
            };

            cacheStore.Write(node.Id, newCache);

            logger.Info("ChannelSync: Folder '{0}' synced — {1} item(s).", node.DisplayName, mergedItems.Count);

            return newCache;
        }

        private static CachedChannelItem ToCache(
            FetchedItem item,
            string fetchInstanceId,
            ChannelObjectKind kind,
            IReadOnlyDictionary<string, CachedChannelItem> priorByStableId)
        {
            var firstSeenUtc = priorByStableId.TryGetValue(item.StableId, out var prior)
                ? prior.FirstSeenUtc
                : DateTimeOffset.UtcNow;

            return new CachedChannelItem
            {
                ProviderKey = fetchInstanceId,
                StableId = item.StableId,
                ObjectKind = kind,
                FirstSeenUtc = firstSeenUtc,
                Title = item.Title,
                OriginalTitle = item.OriginalTitle,
                Year = item.Year,
                Overview = item.Overview,
                PosterUrl = item.PosterUrl,
                ProviderIds = item.ProviderIds
            };
        }

        private async Task TriggerRefreshInternetChannels()
        {
            try
            {
                var worker = taskManager.ScheduledTasks
                    .FirstOrDefault(w => string.Equals(w.ScheduledTask?.Key, RefreshChannelsTaskKey, StringComparison.OrdinalIgnoreCase))
                    ?? taskManager.ScheduledTasks.FirstOrDefault(w => string.Equals(w.Name, RefreshChannelsTaskName, StringComparison.OrdinalIgnoreCase));

                if (worker == null)
                {
                    logger.Warn("ChannelSync: Could not find the built-in channel-refresh task.");
                    return;
                }

                await taskManager.Execute(worker, new TaskOptions()).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Failed to trigger the built-in channel-refresh task", ex);
            }
        }
    }
}