// One of 5 pre-compiled, identical badge slots — see ProviderIdBadgeRegistry
// for why a fixed pool exists instead of dynamic creation. Supports()
// returns false unconditionally when this slot is unbound, so Emby's own
// badge UI never shows anything for an empty slot regardless of how many
// exist — no "slot" concept is ever visible outside this file.
namespace SyncChannel.Providers
{
    using MediaBrowser.Controller.Providers;
    using MediaBrowser.Model.Entities;

    public class GenericProviderIdExternalId3 : IExternalId
    {
        private const int SlotIndex = 2;

        public string Name => ProviderIdBadgeRegistry.KeyForSlot(SlotIndex) ?? string.Empty;
        public string Key => ProviderIdBadgeRegistry.KeyForSlot(SlotIndex) ?? string.Empty;
        public string UrlFormatString => ProviderIdBadgeRegistry.UrlFormatForSlot(SlotIndex);

        public bool Supports(IHasProviderIds item)
        {
            var key = ProviderIdBadgeRegistry.KeyForSlot(SlotIndex);
            return key != null && item.ProviderIds != null && item.ProviderIds.ContainsKey(key);
        }
    }
}