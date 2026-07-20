// Per-folder cache. Deliberately one file per FolderNode.Id rather than one
// global cache — confirmed in Evidence.md that Emby's recursive refresh
// calls GetChannelItems once per folder node, each scoped to that folder's
// own FolderId, and that reconciliation (add/remove) happens per-parent.
// A single global cache would force the channel to filter the whole tree's
// items down to one folder on every browse — this keeps each lookup O(1)
// against just that folder's own file.
namespace SyncChannel.Models
{
    using System.Collections.Generic;

    public class CachedChannelItem
    {
        public string ProviderKey { get; set; } = string.Empty;

        /// <summary>The provider's permanent identity (e.g. Radarr's TitleSlug) — see FetchedItem.StableId.</summary>
        public string StableId { get; set; } = string.Empty;

        public string Title { get; set; } = string.Empty;
        public string OriginalTitle { get; set; } = string.Empty;
        public int? Year { get; set; }
        public string Overview { get; set; } = string.Empty;
        public string PosterUrl { get; set; }
        public Dictionary<string, string> ProviderIds { get; set; } = new Dictionary<string, string>();
    }

    public class FolderCache
    {
        public List<CachedChannelItem> Items { get; set; } = new List<CachedChannelItem>();
        public bool LastSyncSucceeded { get; set; }
        public System.DateTimeOffset? LastSyncUtc { get; set; }

        /// <summary>
        /// Shared across all folders — same reasoning as the original
        /// single-channel cache: one stub file on disk, every channel item
        /// everywhere points at it.
        /// </summary>
        public string StubVideoPath { get; set; } = string.Empty;
    }
}
