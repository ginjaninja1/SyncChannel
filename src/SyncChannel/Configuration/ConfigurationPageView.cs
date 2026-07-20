namespace SyncChannel.Configuration
{
    using SyncChannel.Services;
    using SyncChannel.UIBaseClasses.Views;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.Plugins;
    using MediaBrowser.Model.Plugins.UI.Views;
    using MediaBrowser.Model.Tasks;
    using System;
    using System.Linq;
    using System.Threading;
    using System.Threading.Tasks;

    // Restored debounced-reconciliation pattern from the original
    // ConfigurationPageView — same reasoning as before: AutoPostBack fires
    // SaveConfiguration on every keystroke, and reconciliation (Refresh
    // Internet Channels + tag/image/orphan cleanup) is real server work we
    // don't want firing on every partial keystroke value.
    internal class ConfigurationPageView : PluginPageView
    {
        private const string RefreshChannelsTaskKey = "RefreshInternetChannels";
        private const string RefreshChannelsTaskName = "Refresh Internet Channels";

        private static Timer debounceTimer;
        private static readonly object DebounceLock = new object();
        private const int DebounceMs = 1500;

        private readonly SyncChannelPlugin plugin;
        private readonly ITaskManager taskManager;
        private readonly ChannelIdentityReconciler reconciler;
        private readonly ILogger logger;

        public ConfigurationPageView(
            PluginInfo pluginInfo,
            SyncChannelPlugin plugin,
            ITaskManager taskManager,
            ChannelIdentityReconciler reconciler,
            ILogger logger)
            : base(pluginInfo.Id)
        {
            this.plugin = plugin;
            this.taskManager = taskManager;
            this.reconciler = reconciler;
            this.logger = logger;

            var ui = new ConfigurationUI();
            this.ContentData = ui;
            this.ShowSave = false;

            var cfg = this.plugin.Configuration;
            ui.ChannelName = string.IsNullOrEmpty(cfg.ChannelName) ? "Sync Channel" : cfg.ChannelName;
            ui.ChannelIdentityTag = string.IsNullOrEmpty(cfg.ChannelIdentityTag) ? "ChannelSync:SyncChannel" : cfg.ChannelIdentityTag;
        }

        private ConfigurationUI UI => (ConfigurationUI)this.ContentData;

        public override Task<IPluginUIView> RunCommand(string itemId, string commandId, string data)
        {
            if (commandId == "ConfigurationChanged")
            {
                SaveConfiguration();
                return Task.FromResult<IPluginUIView>(this);
            }

            return base.RunCommand(itemId, commandId, data);
        }

        private void SaveConfiguration()
        {
            var ui = UI;
            var cfg = this.plugin.Configuration;

            string oldChannelName = cfg.ChannelName;
            string oldIdentityTag = cfg.ChannelIdentityTag;

            string channelName = (ui.ChannelName ?? string.Empty).Trim();
            cfg.ChannelName = string.IsNullOrEmpty(channelName) ? "Sync Channel" : channelName;
            ui.ChannelName = cfg.ChannelName;

            string identityTag = (ui.ChannelIdentityTag ?? string.Empty).Trim();
            cfg.ChannelIdentityTag = string.IsNullOrEmpty(identityTag) ? "ChannelSync:SyncChannel" : identityTag;
            ui.ChannelIdentityTag = cfg.ChannelIdentityTag;

            this.plugin.UpdateConfiguration(cfg);

            bool nameChanged = !string.Equals(oldChannelName, cfg.ChannelName, StringComparison.OrdinalIgnoreCase);
            bool tagChanged = !string.Equals(oldIdentityTag, cfg.ChannelIdentityTag, StringComparison.OrdinalIgnoreCase);

            if (nameChanged || tagChanged)
            {
                string lastAppliedTag = cfg.ChannelIdentityTagLastApplied;

                logger.Info(
                    "ChannelSync: Config save queued debounced reconciliation — NameChanged={0}, TagChanged={1}. Will fire in {2}ms if no further edits arrive.",
                    nameChanged, tagChanged, DebounceMs);

                lock (DebounceLock)
                {
                    debounceTimer?.Dispose();
                    debounceTimer = new Timer(_ =>
                    {
                        RunDebouncedReconciliation(tagChanged, lastAppliedTag);
                    }, null, DebounceMs, Timeout.Infinite);
                }
            }
        }

        private void RunDebouncedReconciliation(bool tagChanged, string lastAppliedTag)
        {
            try
            {
                var cfg = this.plugin.Configuration;

                if (tagChanged && !string.IsNullOrEmpty(lastAppliedTag))
                {
                    reconciler.CleanupOrphansForTag(cfg, lastAppliedTag);
                }

                TriggerRefreshInternetChannelsAsync().GetAwaiter().GetResult();
                reconciler.Reconcile(cfg);

                logger.Info("ChannelSync: Debounced post-save reconciliation completed.");
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Debounced reconciliation failed", ex);
            }
        }

        private async Task TriggerRefreshInternetChannelsAsync()
        {
            var refreshWorker = taskManager.ScheduledTasks
                .FirstOrDefault(w => string.Equals(w.ScheduledTask?.Key, RefreshChannelsTaskKey, StringComparison.OrdinalIgnoreCase))
                ?? taskManager.ScheduledTasks
                    .FirstOrDefault(w => string.Equals(w.Name, RefreshChannelsTaskName, StringComparison.OrdinalIgnoreCase));

            if (refreshWorker == null)
            {
                logger.Warn(
                    "ChannelSync: Could not find the built-in channel-refresh task (Key='{0}' / Name='{1}') during debounced reconciliation.",
                    RefreshChannelsTaskKey, RefreshChannelsTaskName);
                return;
            }

            await taskManager.Execute(refreshWorker, new TaskOptions()).ConfigureAwait(false);
        }
    }
}