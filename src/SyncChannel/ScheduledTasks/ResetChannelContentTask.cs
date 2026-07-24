namespace SyncChannel.ScheduledTasks
{
    using MediaBrowser.Controller.Channels;
    using MediaBrowser.Controller.Entities;
    using MediaBrowser.Controller.Library;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.Tasks;
    using SyncChannel.Channels;
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Threading;
    using System.Threading.Tasks;

    /// <summary>
    /// Development-only maintenance task. Deletes every BaseItem currently
    /// persisted under the Sync Channel, so the next real sync recreates
    /// them from scratch — necessary whenever an item's *type* changes
    /// (e.g. Sonarr items moving from Movie to Series), since
    /// GetChannelItemEntity only picks the BaseItem subclass on first
    /// creation and never retypes an existing item in place.
    ///
    /// Does NOT delete anything from Radarr/Sonarr or plugin config/cache —
    /// purely resets Emby's own library rows for this channel's content.
    /// Not registered in the main menu / not intended to run on a schedule;
    /// trigger manually from Scheduled Tasks before testing a build that
    /// changes item typing.
    /// </summary>
    public class ResetChannelContentTask : IScheduledTask
    {
        private readonly IChannelManager channelManager;
        private readonly ILibraryManager libraryManager;
        private readonly ILogger logger;

        public ResetChannelContentTask(
            IChannelManager channelManager,
            ILibraryManager libraryManager,
            ILogger logger)
        {
            this.channelManager = channelManager;
            this.libraryManager = libraryManager;
            this.logger = logger;
        }

        public string Name => "Reset Sync Channel Content (dev)";
        public string Key => "ChannelSync-ResetContent";
        public string Description =>
            "DEV ONLY: deletes every item currently persisted under the Sync Channel from Emby's library, so the next sync recreates them fresh with correct typing. Does not touch Radarr/Sonarr or plugin config/cache files.";
        public string Category => "GinjaNinja Tools";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            // No default trigger — manual-run only.
            return Array.Empty<TaskTriggerInfo>();
        }

        public Task Execute(CancellationToken cancellationToken, IProgress<double> progress)
        {
            var channel = channelManager.GetChannel<SyncFolderChannel>();
            if (channel == null)
            {
                logger.Warn("ChannelSync: SyncFolderChannel not registered yet — nothing to reset.");
                return Task.CompletedTask;
            }

            var channelItem = FindChannelBaseItem();
            if (channelItem == null)
            {
                logger.Warn("ChannelSync: Could not find the Channel BaseItem in the library — nothing to reset.");
                return Task.CompletedTask;
            }

            var toDelete = libraryManager.GetItemsResult(new InternalItemsQuery
            {
                Parent = channelItem,
                Recursive = true
            }).Items;

            logger.Info("ChannelSync: Reset task deleting {0} item(s) under the Sync Channel.", toDelete.Length);

            int deleted = 0;
            foreach (var item in toDelete)
            {
                try
                {
                    libraryManager.DeleteItem(item, new DeleteOptions { DeleteFileLocation = false });
                    deleted++;
                }
                catch (Exception ex)
                {
                    logger.ErrorException("ChannelSync: Failed to delete item '{0}' (InternalId={1}) during reset", ex, item.Name, item.InternalId);
                }
            }

            logger.Info("ChannelSync: Reset task complete — deleted {0}/{1} item(s). Run 'Sync Coming Soon Folder Tree' next to repopulate.", deleted, toDelete.Length);
            progress.Report(100);

            return Task.CompletedTask;
        }

        private BaseItem FindChannelBaseItem()
        {
            return libraryManager.GetItemsResult(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { "Channel" },
                Name = SyncChannelPlugin.Instance.Configuration.ChannelName
            }).Items.FirstOrDefault();
        }
    }
}