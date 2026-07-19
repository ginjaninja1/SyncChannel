namespace SyncChannel
{
    using SyncChannel.Configuration;
    using SyncChannel.Services;
    using SyncChannel.UI;
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
        // Freshly generated for this plugin — deliberately NOT the same as
        // ManageComingSoonPlugin's Guid. The two plugins are unrelated as
        // far as Emby's plugin registry is concerned.
        private static readonly Guid PluginId = new Guid("6b2e4f17-9a3c-4d8b-8e1f-2c7a5b9d3e60");

        private readonly IServerApplicationHost appHost;
        private readonly ITaskManager taskManager;
        private readonly ILogger logger;
        private List<IPluginUIPageController> pages;
        private RadarrChannelIdentityReconciler reconcilerInstance;

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
            "Surfaces monitored-but-not-yet-downloaded Radarr movies as an Emby channel, " +
            "with automatic add/remove sync and a configurable placeholder video.";

        public ImageFormat ThumbImageFormat => ImageFormat.Png;

        public Stream GetThumbImage()
        {
            var type = GetType();
            return type.Assembly.GetManifestResourceStream(type.Namespace + ".thumb.png")
                   ?? Stream.Null;
        }

        // -----------------------------------------------------------------
        // IHasWebPages — serves the Radarr Rules editor as a raw embedded
        // HTML/JS page (token-based drag/drop expression builder). Ported
        // over unchanged from ManageComingSoon; see that project's
        // Evidence.md for the confirmed IHasWebPages / EmbeddedResourcePath
        // pattern this relies on.
        // -----------------------------------------------------------------
        public IEnumerable<PluginPageInfo> GetPages()
        {
            return new[]
            {
                new PluginPageInfo
                {
                    Name = "RadarrRulesPage",
                    EmbeddedResourcePath = GetType().Namespace + ".Rules.WebUI.rulesPage.html",
                    EnableInMainMenu = true,
                    DisplayName = "Radarr Coming Soon Rules",
                    MenuIcon = "rule_folder"
                },
                new PluginPageInfo
                {
                    Name = "RadarrRulesPageJs",
                    EmbeddedResourcePath = GetType().Namespace + ".Rules.WebUI.rulesPage.js"
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
                        this.reconcilerInstance = new RadarrChannelIdentityReconciler(
                            channelManager, libraryManager, imageProcessor,
                            appPaths, this.logger);
                    }

                    this.pages = new List<IPluginUIPageController>
                    {
                        new MainPageController(
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
