namespace SyncChannel.Providers
{
    using MediaBrowser.Controller.Providers;
    using MediaBrowser.Model.Entities;

    public class RadarrExternalId : IExternalId
    {
        public string Name => "Radarr";

        public string Key => "RadarrId";

        // ProviderIds["RadarrId"] is stored as the fully-resolved detail
        // URL at fetch time (see HttpFetchProvider.EvaluateAndMap), so this
        // format string is just a pass-through.
        public string UrlFormatString => "{0}";

        public bool Supports(IHasProviderIds item) =>
            item.ProviderIds.ContainsKey("RadarrId");
    }
}