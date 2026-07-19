namespace SyncChannel.Configuration
{
    using MediaBrowser.Model.Plugins;

    public enum RadarrSyncMode
    {
        // Scheduled task is the only thing that talks to Radarr; results are
        // written to a local cache file and GetChannelItems reads the cache
        // only. Default — decouples channel browsing from Radarr uptime.
        Cached,

        // GetChannelItems calls Radarr directly on every request. Simpler,
        // always fresh, but ties the channel's availability/responsiveness
        // to Radarr being reachable at that exact moment.
        Live
    }

    public class PluginConfiguration : BasePluginConfiguration
    {
        // ---- Radarr connection ----
        public string RadarrUrl { get; set; } = "http://127.0.0.1:7878";

        public string RadarrApiKey { get; set; } = string.Empty;

        // ---- "Radarr Coming Soon" channel ----
        // Master switch for the whole feature. Everything below is inert
        // while this is false.
        public bool RadarrEnabled { get; set; } = false;

        // Display name of the channel in Emby. Changing this creates a new
        // Channel DB row (channels are keyed by Name) and orphans the old
        // one — RadarrChannelIdentityTag below is what lets the reconciler
        // find and clean up that orphan.
        public string RadarrChannelName { get; set; } = "Radarr Coming Soon";

        public int RadarrRefreshMinutes { get; set; } = 15;

        // Cached vs Live — see RadarrSyncMode doc comments above.
        public RadarrSyncMode RadarrSyncMode { get; set; } = RadarrSyncMode.Cached;

        // Empty = use the plugin's embedded default placeholder video;
        // non-empty = a validated custom path. This is the file every
        // channel item's MediaSources points at for playback.
        public string RadarrStubVideoPath { get; set; } = string.Empty;

        // Fixed identity marker applied to the Channel BaseItem, independent
        // of RadarrChannelName. Survives a channel rename, letting the sync
        // task find "this plugin's channel" even after the Name-keyed DB row
        // changes — and flag any other Channel item carrying this tag as a
        // stale orphan.
        public string RadarrChannelIdentityTag { get; set; } = "ChannelSync:RadarrChannel";

        // Internal bookkeeping — the identity tag value most recently written
        // to the Channel BaseItem. Not user-facing. Lets the reconciler know
        // exactly which stale tag to remove when RadarrChannelIdentityTag
        // changes, instead of only ever adding and leaving old values behind.
        public string RadarrChannelIdentityTagLastApplied { get; set; } = string.Empty;
    }
}
