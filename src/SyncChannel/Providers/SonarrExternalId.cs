namespace SyncChannel.Providers
{
    using MediaBrowser.Controller.Providers;
    using MediaBrowser.Model.Entities;

    public class SonarrExternalId : IExternalId
    {
        public string Name => "Sonarr";

        public string Key => "SonarrId";

        public string UrlFormatString => "{0}";

        public bool Supports(IHasProviderIds item) =>
            item.ProviderIds.ContainsKey("SonarrId");
    }
}