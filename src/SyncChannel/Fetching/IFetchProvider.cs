// New in this pass: the provider abstraction that lets a single FolderNode
// hold fetches from multiple, differently-shaped sources (Radarr, Sonarr,
// future providers) without the channel or folder-tree code ever needing to
// know a provider's specific field set. See RadarrFetchProvider.cs for the
// first real implementation, wrapping the existing RadarrClient/RuleEvaluator
// machinery unchanged.
namespace SyncChannel.Fetching
{
    using System.Collections.Generic;
    using System.Threading;
    using System.Threading.Tasks;

    public enum FetchFieldType
    {
        String,
        Password,   // rendered masked in the UI, e.g. API keys
        Number,
        Bool,
        RuleSetPicker // special-cased: renders as a dropdown of that provider's saved rule sets
    }

    public class FetchFieldDefinition
    {
        public string Key { get; set; }
        public string DisplayName { get; set; }
        public string Description { get; set; }
        public FetchFieldType Type { get; set; } = FetchFieldType.String;
        public bool Required { get; set; }
        public string DefaultValue { get; set; } = string.Empty;
    }

    /// <summary>
    /// A single item returned by a provider fetch, in a provider-agnostic
    /// shape the channel can turn into a ChannelItemInfo without caring
    /// which provider produced it.
    /// </summary>
    public class FetchedItem
    {
        public string StableId { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public string OriginalTitle { get; set; } = string.Empty;
        public int? Year { get; set; }
        public string Overview { get; set; } = string.Empty;
        public string PosterUrl { get; set; }

        // MusicArtistAlbum kind only — resolved from EndpointSchema's
        // ArtistField/AlbumArtistField/AlbumField. Flow through to
        // ChannelItemInfo.Artists/AlbumArtists/Album in SyncFolderChannel,
        // read directly off ChannelItemInfo by Emby's ChannelManager
        // (confirmed via ILSpy — independent of parent folder's runtime
        // type, since MusicArtist/MusicAlbum FolderTypes don't construct
        // real typed classes).
        public string Artist { get; set; } = string.Empty;
        public string AlbumArtist { get; set; } = string.Empty;
        public string Album { get; set; } = string.Empty;

        // PhotoAlbum kind only — the actual image file URL, resolved from
        // EndpointSchema.MediaFileUrlField. Distinct from PosterUrl (a
        // thumbnail set via ImageUrl) — this becomes the Photo BaseItem's
        // MediaSourceInfo.Path (confirmed via ILSpy).
        public string MediaFileUrl { get; set; } = string.Empty;

        public Dictionary<string, string> ProviderIds { get; set; } = new Dictionary<string, string>();
    }

    /// <summary>
    /// One pluggable data source. A FolderNode holds zero or more
    /// FetchRuleInstance entries, each naming a ProviderKey that resolves to
    /// one of these via FetchProviderRegistry.
    /// </summary>
    public interface IFetchProvider
    {
        /// <summary>Stable key stored in FetchRuleInstance.ProviderKey — e.g. "radarr".</summary>
        string ProviderKey { get; }

        /// <summary>Human-readable name shown in the "Add Fetch" provider picker.</summary>
        string DisplayName { get; }

        /// <summary>
        /// Drives both the admin UI's generated edit form and basic
        /// server-side validation. Never hardcoded into UI/JS — new
        /// providers appear automatically once registered.
        /// </summary>
        IEnumerable<FetchFieldDefinition> GetFieldSchema();

        /// <summary>
        /// Runs the fetch. MUST return null (never an empty list) on any
        /// failure — same contract already established for Radarr in
        /// Evidence.md: null means "sync skipped, leave existing state
        /// untouched", never "zero items qualify".
        /// </summary>
        Task<IReadOnlyList<FetchedItem>> FetchAsync(Dictionary<string, string> settings, CancellationToken cancellationToken);
    }
}