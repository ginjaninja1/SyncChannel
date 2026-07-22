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
    ChannelIdentityReconciler reconciler,   // <-- was missing
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
            this.reconciler = reconciler;           // now actually assigned
            this.logger = logger;
        }

        public string Name => "Sync Coming Soon Folder Tree";
        public string Key => "ChannelSync-FolderTreeSync";
        public string Description =>
            "Runs every configured fetch for every folder in the admin-defined folder tree, updates each folder's cache, and persists the results into Emby. Change the schedule here, in Scheduled Tasks — there is no separate interval setting in plugin config.";
        public string Category => "Channel Sync";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            // Default only — the user can change this from Emby's own
            // Scheduled Tasks page, and that edit is Emby's to persist, not
            // ours. No plugin-config interval field to keep in sync anymore.
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
            await SyncNode(tree.RootFolder, connections, schemas, ruleSets, allFolderIds, cancellationToken).ConfigureAwait(false);

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

            foreach (var folderId in folderIds)
            {
                var node = FolderTreeStore.FindNode(tree.RootFolder, folderId);
                if (node != null)
                {
                    await SyncSingleNode(node, connections, schemas, ruleSets, cancellationToken).ConfigureAwait(false);
                }
            }

            var channel = channelManager.GetChannel<SyncFolderChannel>();
            if (channel != null)
            {
                try { await channelManager.RefreshChannelContent(channel, 8, null, cancellationToken).ConfigureAwait(false); }
                catch (Exception ex) { logger.ErrorException("ChannelSync: RefreshChannelContent failed (responsive save)", ex); }
            }

            await TriggerRefreshInternetChannels().ConfigureAwait(false);
        }

        private async Task SyncNode(
            FolderNode node,
            Dictionary<string, ConnectionEntry> connections,
            Dictionary<string, EndpointSchema> schemas,
            Dictionary<string, RuleSet> ruleSets,
            List<string> allFolderIds,
            CancellationToken cancellationToken)
        {
            allFolderIds.Add(node.Id);
            await SyncSingleNode(node, connections, schemas, ruleSets, cancellationToken).ConfigureAwait(false);

            foreach (var child in node.Children)
            {
                await SyncNode(child, connections, schemas, ruleSets, allFolderIds, cancellationToken).ConfigureAwait(false);
            }
        }

        private async Task SyncSingleNode(
            FolderNode node,
            Dictionary<string, ConnectionEntry> connections,
            Dictionary<string, EndpointSchema> schemas,
            Dictionary<string, RuleSet> ruleSets,
            CancellationToken cancellationToken)
        {
            var existingCache = cacheStore.Read(node.Id);
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
                    // Fetch failed — carry forward this fetch's prior contribution.
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
                // ProviderKey now stores the FetchRuleInstance.Id — the
                // per-fetch key needed to carry forward this specific
                // fetch's contribution on a future partial failure (a
                // folder can have multiple fetches against the same schema).
                mergedItems.AddRange(results.Select(r => ToCache(r, fetch.Id, schema.ObjectKind)));
            }

            if (anyAttempted)
            {
                cacheStore.Write(node.Id, new FolderCache
                {
                    Items = mergedItems,
                    LastSyncSucceeded = anySucceeded,
                    LastSyncUtc = DateTimeOffset.UtcNow,
                    StubVideoPath = existingCache.StubVideoPath
                });

                logger.Info("ChannelSync: Folder '{0}' synced — {1} item(s).", node.DisplayName, mergedItems.Count);
            }
        }

        private static CachedChannelItem ToCache(FetchedItem item, string fetchInstanceId, ChannelObjectKind kind) => new CachedChannelItem
        {
            ProviderKey = fetchInstanceId,
            StableId = item.StableId,
            ObjectKind = kind,
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