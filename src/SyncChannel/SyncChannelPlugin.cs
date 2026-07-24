namespace SyncChannel
{
    using SyncChannel.Configuration;
    using MediaBrowser.Common.Configuration;
    using MediaBrowser.Common.Plugins;
    using MediaBrowser.Model.Drawing;
    using MediaBrowser.Model.Plugins;
    using MediaBrowser.Model.Serialization;
    using System;
    using System.Collections.Generic;
    using System.IO;

    public class SyncChannelPlugin : BasePlugin<PluginConfiguration>, IHasThumbImage, IHasWebPages
    {
        private static readonly Guid PluginId = new Guid("6b2e4f17-9a3c-4d8b-8e1f-2c7a5b9d3e60");

        public static SyncChannelPlugin Instance { get; private set; }

        public SyncChannelPlugin(
            IApplicationPaths applicationPaths,
            IXmlSerializer xmlSerializer)
            : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
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

        // IHasUIPages (Emby.Web.GenericEdit config page) is deliberately not
        // implemented right now — hidden per operator request, not deleted.
        // ConfigurationPageView.cs / ConfigurationUI.cs / MainPageController.cs
        // are excluded from compilation (see .csproj) rather than removed, so
        // this can be reinstated later without rewriting them.
        public IEnumerable<PluginPageInfo> GetPages()
        {
            return new[]
            {
                new PluginPageInfo
                {
                    Name = "SyncChannelPage",
                    EmbeddedResourcePath = GetType().Namespace + ".Rules.WebUI.SyncChannel.html",
                    EnableInMainMenu = true,
                    //EnableInUserMenu = true,
                    DisplayName = "Channel Sync",
                    //MenuIcon = "upcoming"
                    MenuIcon = "directory_sync"
                },
                new PluginPageInfo
                {
                    Name = "SyncChannelPageJs",
                    EmbeddedResourcePath = GetType().Namespace + ".Rules.WebUI.SyncChannel.js"
                }
            };
        }
    }
}