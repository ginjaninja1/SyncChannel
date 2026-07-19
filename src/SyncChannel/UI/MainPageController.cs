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

    // Unlike ManageComingSoon's MainPageController, this plugin has only one
    // settings surface (Configuration) — the Rules editor is served as its
    // own standalone page via IHasWebPages, independent of this controller.
    // So no tab machinery (IHasTabbedUIPages / TabPageController) is needed
    // here at all — just a single IsMainConfigPage page.
    internal class MainPageController : ControllerBase
    {
        private readonly PluginInfo pluginInfo;
        private readonly SyncChannelPlugin plugin;
        private readonly ITaskManager taskManager;
        private readonly RadarrChannelIdentityReconciler reconciler;
        private readonly ILogger logger;

        public MainPageController(
            PluginInfo pluginInfo,
            SyncChannelPlugin plugin,
            ITaskManager taskManager,
            RadarrChannelIdentityReconciler reconciler,
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
