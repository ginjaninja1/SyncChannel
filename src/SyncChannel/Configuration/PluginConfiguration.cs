namespace SyncChannel.Configuration
{
    using MediaBrowser.Model.Plugins;

    public class PluginConfiguration : BasePluginConfiguration
    {
        // Display name of the "Sync Channel" in Emby. Changing this creates
        // a new Channel DB row (channels are keyed by Name) and orphans the
        // old one — ChannelIdentityTag below is what lets the reconciler
        // find and clean up that orphan. See Evidence.md's "Channel
        // Persistence and Database Identity" section.
        public string ChannelName { get; set; } = "Channel Sync";

        // Fixed identity marker applied to the Channel BaseItem, independent
        // of ChannelName. Survives a rename, letting the sync task find
        // "this plugin's channel" even after the Name-keyed DB row changes —
        // and flag any other Channel item carrying this tag as a stale
        // orphan.
        public string ChannelIdentityTag { get; set; } = "SyncChannel";

        // Internal bookkeeping — the identity tag value most recently
        // written to the Channel BaseItem. Not user-facing. Lets the
        // reconciler know exactly which stale tag to remove when
        // ChannelIdentityTag changes, instead of only ever adding and
        // leaving old values behind.
        public string ChannelIdentityTagLastApplied { get; set; } = string.Empty;

        // Opt-in runtime compatibility harness. These items are emitted under
        // a reserved "Media Tests" channel folder and exercise Emby's real
        // channel persistence/playback paths without requiring an endpoint
        // schema or hand-authored source service.
        public bool EnableMediaTestHarness { get; set; }
        public string MediaTestVideoUrl { get; set; } = "https://developer.mozilla.org/shared-assets/videos/flower.mp4";
        public string MediaTestAudioUrl { get; set; } = "https://developer.mozilla.org/shared-assets/audio/t-rex-roar.mp3";
        public string MediaTestImageUrl { get; set; } = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3f/Fronalpstock_big.jpg/640px-Fronalpstock_big.jpg";
        public string MediaTestHlsUrl { get; set; } = "http://devimages.apple.com/iphone/samples/bipbop/bipbopall.m3u8";

        // Internal path populated when the harness downloads ImageUrl. Emby
        // 4.10's PhotoProvider passes Photo.Path to LibVips as a local file;
        // it cannot consume an HTTP URL there.
        public string MediaTestCachedImagePath { get; set; } = string.Empty;
    }
}
