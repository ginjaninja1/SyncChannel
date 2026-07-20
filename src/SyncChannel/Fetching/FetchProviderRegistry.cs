namespace SyncChannel.Fetching
{
    using System.Collections.Generic;
    using System.Linq;

    /// <summary>
    /// Resolves ProviderKey -> IFetchProvider.
    ///
    /// Constructed the same way as every other dependency in this codebase
    /// that feeds an auto-discovered class (IChannel/IScheduledTask/IService
    /// — confirmed in Evidence.md to use GetExports&lt;T&gt;() with zero
    /// manual registration): via ordinary concrete-class constructor
    /// injection, resolved by Emby's own container. Deliberately NOT
    /// IEnumerable&lt;IFetchProvider&gt; or a params array — nothing in
    /// Evidence.md confirms the container supports collection-injection
    /// against a custom interface, whereas named concrete-class parameters
    /// (e.g. RadarrClient's dependency chain, itself injected into the
    /// auto-discovered RadarrComingSoonChannel) are demonstrated working.
    /// Adding a new provider means adding one constructor parameter here.
    /// </summary>
    public class FetchProviderRegistry
    {
        private readonly Dictionary<string, IFetchProvider> providersByKey;

        // Named concrete-class parameters, not an IEnumerable<IFetchProvider>
        // or params array — this is the exact DI shape already confirmed
        // working for auto-discovered classes in this codebase (e.g.
        // RadarrClient's multi-level concrete dependency chain, itself
        // constructor-injected into the auto-discovered
        // RadarrComingSoonChannel). Adding a new provider (e.g. Sonarr)
        // means adding one parameter here.
        public FetchProviderRegistry(RadarrFetchProvider radarrProvider)
        {
            this.providersByKey = new Dictionary<string, IFetchProvider>(System.StringComparer.OrdinalIgnoreCase);

            foreach (var provider in new IFetchProvider[] { radarrProvider })
            {
                if (provider != null)
                {
                    this.providersByKey[provider.ProviderKey] = provider;
                }
            }
        }

        public IFetchProvider Get(string providerKey)
        {
            if (string.IsNullOrEmpty(providerKey))
            {
                return null;
            }

            this.providersByKey.TryGetValue(providerKey, out var provider);
            return provider;
        }

        public IReadOnlyCollection<IFetchProvider> All => this.providersByKey.Values;
    }
}
