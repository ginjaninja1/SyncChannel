namespace SyncChannel.Configuration
{
    using Emby.Web.GenericEdit;
    using Emby.Web.GenericEdit.Common;
    using Emby.Web.GenericEdit.Elements;
    using Emby.Web.GenericEdit.Elements.List;
    using MediaBrowser.Model.Attributes;
    using System.ComponentModel;

    public class ConfigurationUI : EditableOptionsBase
    {
        public override string EditorTitle => "Channel Sync";

        public override string EditorDescription =>
            "Settings that rarely change. Changes are saved automatically.";

        public CaptionItem CaptionRadarr { get; set; } =
            new CaptionItem("Radarr Coming Soon Channel");

        [DisplayName("Enable Radarr integration")]
        [Description("Master switch. Everything below only applies when this is on.")]
        [AutoPostBack("ConfigurationChanged", nameof(RadarrEnabled))]
        public bool RadarrEnabled { get; set; } = false;

        [DisplayName("Channel name")]
        [Description("Display name of the Radarr channel in Emby. Changing this creates a new channel entry in Emby and orphans the old one.")]
        [EnabledCondition(nameof(RadarrEnabled), SimpleCondition.IsTrue)]
        [AutoPostBack("ConfigurationChanged", nameof(RadarrChannelName))]
        public string RadarrChannelName { get; set; } = "Radarr Coming Soon";

        [DisplayName("Radarr URL")]
        [Description("e.g. http://127.0.0.1:7878")]
        [EnabledCondition(nameof(RadarrEnabled), SimpleCondition.IsTrue)]
        [AutoPostBack("ConfigurationChanged", nameof(RadarrUrl))]
        public string RadarrUrl { get; set; } = "http://127.0.0.1:7878";

        [DisplayName("Radarr API Key")]
        [Description("Found in Radarr under Settings > General > Security")]
        [EnabledCondition(nameof(RadarrEnabled), SimpleCondition.IsTrue)]
        [AutoPostBack("ConfigurationChanged", nameof(RadarrApiKey))]
        public string RadarrApiKey { get; set; } = string.Empty;

        [DisplayName("Channel identity tag")]
        [Description("Internal marker tag used to find this channel's database entry across renames, and to detect orphaned entries left behind by a previous name.")]
        [EnabledCondition(nameof(RadarrEnabled), SimpleCondition.IsTrue)]
        [AutoPostBack("ConfigurationChanged", nameof(RadarrChannelIdentityTag))]
        public string RadarrChannelIdentityTag { get; set; } = "ChannelSync:RadarrChannel";

        [DisplayName("Sync interval (minutes)")]
        [Description("How often the Cached-mode scheduled task queries Radarr")]
        [Required]
        [EnabledCondition(nameof(RadarrEnabled), SimpleCondition.IsTrue)]
        [AutoPostBack("ConfigurationChanged", nameof(RadarrRefreshMinutes))]
        public int RadarrRefreshMinutes { get; set; } = 15;

        [DisplayName("Sync mode")]
        [Description(
            "Cached: the scheduled task syncs periodically and the channel reads from that cache. " +
            "Live: the channel calls Radarr directly every time it's viewed.")]
        [EnabledCondition(nameof(RadarrEnabled), SimpleCondition.IsTrue)]
        [AutoPostBack("ConfigurationChanged", nameof(RadarrSyncMode))]
        public RadarrSyncMode RadarrSyncMode { get; set; } = RadarrSyncMode.Cached;

        [DisplayName("Choose your own placeholder video file")]
        [Description(
            "Path to a video file (mp4, mkv, avi, mov) that channel items will play. " +
            "Leave blank to use the default. To change an existing selection, clear this field first.")]
        [EnabledCondition(nameof(RadarrEnabled), SimpleCondition.IsTrue)]
        [AutoPostBack("ConfigurationChanged", nameof(RadarrStubVideoPath))]
        [EditFilePicker]
        public string RadarrStubVideoPath { get; set; } = string.Empty;

        [Browsable(false)]
        public GenericListItem StubVideoStatusItem { get; set; } = new GenericListItem
        {
            PrimaryText = "Placeholder Video File",
            Status = ItemStatus.Unavailable,
            Icon = IconNames.video_library,
            Button1 = new ButtonItem("Clear Selection")
            {
                StandardIcon = StandardIcons.Remove,
                Data1 = "ClearStubVideo",
                CommandId = "ClearStubVideo",
            }
        };

        // The item must live inside a collection to be rendered on screen,
        // but StubVideoStatusItem above is the single source of truth for its content.
        public GenericItemList StubVideoStatusList => new GenericItemList { StubVideoStatusItem };

        public SpacerItem Spacer1 { get; set; } = new SpacerItem();

        public GenericItemList RadarrRulesLink { get; set; } = new GenericItemList
        {
            new GenericListItem
            {
                PrimaryText = "Manage Radarr Coming Soon Rules",
                SecondaryText = "Edit which Radarr movies appear in the channel",
                Icon = IconNames.rule_folder,
                Status = ItemStatus.None,
                HyperLink = "configurationpage?name=RadarrRulesPage",
                HyperLinkTargetExternal = false
            }
        };
    }
}
