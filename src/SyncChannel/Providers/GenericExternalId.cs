// Old RadarrExternalId built its click-through URL from a single global
// config value (config.RadarrUrl). That doesn't generalize once there can
// be N connections. Simplest correct fix: store the fully-resolved detail
// URL directly on the item at fetch time (schema-specific, since only the
// schema knows its own URL shape) rather than trying to reconstruct it
// later from a stored id + a guessed format string.
namespace SyncChannel.Providers
{
    using MediaBrowser.Controller.Providers;
    using MediaBrowser.Model.Entities;

    public class GenericExternalId : IExternalId
    {
        public string Name => "Source";

        public string Key => "SourceUrl";

        // {0} substituted with whatever's stored under ProviderIds["SourceUrl"],
        // which HttpFetchProvider populates as the full URL already — so this
        // format string is just a pass-through.
        public string UrlFormatString => "{0}";

        public bool Supports(IHasProviderIds item) =>
            item.ProviderIds.ContainsKey("SourceUrl");
    }
}