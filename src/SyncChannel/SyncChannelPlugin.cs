namespace SyncChannel
{
    using SyncChannel.Configuration;
    using SyncChannel.Services;
    using MediaBrowser.Common.Configuration;
    using MediaBrowser.Common.Plugins;
    using MediaBrowser.Controller;
    using MediaBrowser.Controller.Channels;
    using MediaBrowser.Controller.Drawing;
    using MediaBrowser.Controller.Library;
    using MediaBrowser.Model.Drawing;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.Plugins;
    using MediaBrowser.Model.Plugins.UI;
    using MediaBrowser.Model.Serialization;
    using MediaBrowser.Model.Tasks;
    using System;
    using System.Collections.Generic;
    using System.IO;

    public class SyncChannelPlugin : BasePlugin<PluginConfiguration>, IHasThumbImage, IHasUIPages, IHasWebPages
    {
        private static readonly Guid PluginId = new Guid("6b2e4f17-9a3c-4d8b-8e1f-2c7a5b9d3e60");

        private readonly IServerApplicationHost appHost;
        private readonly ITaskManager taskManager;
        private readonly ILogger logger;
        private List<IPluginUIPageController> pages;
        private ChannelIdentityReconciler reconcilerInstance;

        public static SyncChannelPlugin Instance { get; private set; }

        public SyncChannelPlugin(
            IServerApplicationHost applicationHost,
            IApplicationPaths applicationPaths,
            IXmlSerializer xmlSerializer,
            ILogManager logManager,
            ITaskManager taskManager)
            : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
            this.appHost = applicationHost;
            this.logger = logManager.GetLogger(Name);
            this.taskManager = taskManager;
        }

        public override Guid Id => PluginId;
        public override string Name => "Channel Sync";
        public override string Description =>
            "Surfaces monitored-but-not-yet-downloaded items from Radarr, Sonarr, or any similar REST API as an Emby channel, organized into an admin-defined, renameable folder tree, with configurable connections, endpoint schemas, and rule sets.";

        public ImageFormat ThumbImageFormat => ImageFormat.Png;

        public Stream GetThumbImage()
        {
            var type = GetType();
            return type.Assembly.GetManifestResourceStream(type.Namespace + ".thumb.png")
                   ?? Stream.Null;
        }

        public IEnumerable<PluginPageInfo> GetPages()
        {
            return new[]
            {
                new PluginPageInfo
                {
                    Name = "ManageComingSoonPage",
                    EmbeddedResourcePath = GetType().Namespace + ".Rules.WebUI.manageComingSoonPage.html",
                    EnableInMainMenu = false,
                    DisplayName = "Manage Coming Soon",
                    MenuIcon = "folder_special"
                },
                new PluginPageInfo
                {
                    Name = "ManageComingSoonPageJs",
                    EmbeddedResourcePath = GetType().Namespace + ".Rules.WebUI.manageComingSoonPage.js"
                }
            };
        }

        public IReadOnlyCollection<IPluginUIPageController> UIPageControllers
        {
            get
            {
                if (this.pages == null)
                {
                    var libraryManager = this.appHost.Resolve<ILibraryManager>();
                    var channelManager = this.appHost.Resolve<IChannelManager>();
                    var imageProcessor = this.appHost.Resolve<IImageProcessor>();
                    var appPaths = this.appHost.Resolve<IApplicationPaths>();

                    if (this.reconcilerInstance == null)
                    {
                        this.reconcilerInstance = new ChannelIdentityReconciler(
                            channelManager, libraryManager, imageProcessor,
                            appPaths, this.logger);
                    }

                    this.pages = new List<IPluginUIPageController>
                    {
                        new UI.MainPageController(
                            GetPluginInfo(),
                            this,
                            this.taskManager,
                            this.reconcilerInstance,
                            this.logger)
                    };
                }

                return this.pages.AsReadOnly();
            }
        }
    }
}