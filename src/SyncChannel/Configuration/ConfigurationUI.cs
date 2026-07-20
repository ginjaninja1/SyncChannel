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
            "Renaming the channel below creates a new channel entry in Emby and orphans the old one — this is handled automatically. Connections, endpoint schemas, rule sets, and the folder tree are managed on the Manage Coming Soon page below.";

        [DisplayName("Channel name")]
        [Description("Display name of the Sync Channel in Emby. Changing this creates a new channel entry and orphans the old one.")]
        [AutoPostBack("ConfigurationChanged", nameof(ChannelName))]
        public string ChannelName { get; set; } = "Sync Channel";

        [DisplayName("Channel identity tag")]
        [Description("Internal marker tag used to find this channel's database entry across renames, and to detect orphaned entries left behind by a previous name.")]
        [AutoPostBack("ConfigurationChanged", nameof(ChannelIdentityTag))]
        public string ChannelIdentityTag { get; set; } = "ChannelSync:SyncChannel";

        public SpacerItem Spacer1 { get; set; } = new SpacerItem();

        public GenericItemList ManageLink { get; set; } = new GenericItemList
        {
            new GenericListItem
            {
                PrimaryText = "Manage Coming Soon",
                SecondaryText = "Connections, rule sets, and the folder tree",
                Icon = IconNames.folder_special,
                Status = ItemStatus.None,
                HyperLink = "configurationpage?name=ManageComingSoonPage",
                HyperLinkTargetExternal = false
            }
        };
    }
}