namespace SyncChannel.UI
{
    using System.Threading.Tasks;
    using SyncChannel.Configuration;
    using SyncChannel.Services;
    using SyncChannel.UIBaseClasses;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.Plugins;
    using MediaBrowser.Model.Plugins.UI.Views;
    using MediaBrowser.Model.Tasks;

    internal class MainPageController : ControllerBase
    {
        private readonly PluginInfo pluginInfo;
        private readonly SyncChannelPlugin plugin;
        private readonly ITaskManager taskManager;
        private readonly ChannelIdentityReconciler reconciler;
        private readonly ILogger logger;

        public MainPageController(
            PluginInfo pluginInfo,
            SyncChannelPlugin plugin,
            ITaskManager taskManager,
            ChannelIdentityReconciler reconciler,
            ILogger logger)
            : base(pluginInfo.Id)
        {
            this.pluginInfo = pluginInfo;
            this.plugin = plugin;
            this.taskManager = taskManager;
            this.reconciler = reconciler;
            this.logger = logger;

            PageInfo = new PluginPageInfo
            {
                Name = "ChannelSync",
                EnableInMainMenu = true,
                DisplayName = "Channel Sync",
                MenuIcon = "upcoming",
                IsMainConfigPage = true,
            };
        }

        public override PluginPageInfo PageInfo { get; }

        public override Task<IPluginUIView> CreateDefaultPageView()
        {
            IPluginUIView view = new ConfigurationPageView(
                pluginInfo, plugin, taskManager, reconciler, logger);
            return Task.FromResult(view);
        }
    }
}