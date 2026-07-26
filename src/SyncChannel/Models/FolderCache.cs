// Per-folder cache. Deliberately one file per FolderNode.Id rather than one
// global cache — confirmed in Evidence.md that Emby's recursive refresh
// calls GetChannelItems once per folder node, each scoped to that folder's
// own FolderId, and that reconciliation (add/remove) happens per-parent.
// A single global cache would force the channel to filter the whole tree's
// items down to one folder on every browse — this keeps each lookup O(1)
// against just that folder's own file.
namespace SyncChannel.Models
{
    using SyncChannel.Configuration;
    using System;
    using System.Collections.Generic;

    public class CachedChannelItem
    {
        public string ProviderKey { get; set; } = string.Empty;

        /// <summary>When this StableId first appeared in this folder's cache — carried forward across syncs, never re-stamped once set.</summary>
        public DateTimeOffset FirstSeenUtc { get; set; }

        /// <summary>The provider's permanent identity (e.g. Radarr's TitleSlug) — see FetchedItem.StableId.</summary>
        public string StableId { get; set; } = string.Empty;

        // Which Emby channel object this item becomes — see
        // ChannelObjectKind. Carried from the EndpointSchema that produced
        // it (FolderTreeSyncTask.ToCache) through to SyncFolderChannel.
        public ChannelObjectKind ObjectKind { get; set; }

        // Copied from EndpointSchema at ToCache time, alongside ObjectKind,
        // so SyncFolderChannel can construct the right ChannelItemInfo
        // without a schema lookup at browse time. FlatMedia/MusicArtistAlbum/
        // GenericContainer leaves only — ignored for Series/PhotoAlbum,
        // which have fixed leaf shapes by construction (see EndpointSchema
        // comments).
        public LeafMediaType LeafMediaType { get; set; }
        public LeafContentType LeafContentType { get; set; }

        // GenericContainer kind only — copied from EndpointSchema at
        // ToCache time. How many synthetic Container-typed folder levels
        // sit between this item and its playable leaf, and their display
        // labels.
        public int ContainerLevelCount { get; set; }
        public List<string> ContainerLevelNames { get; set; } = new List<string>();

        public string Title { get; set; } = string.Empty;
        public string OriginalTitle { get; set; } = string.Empty;
        public int? Year { get; set; }
        public string Overview { get; set; } = string.Empty;
        public string PosterUrl { get; set; }

        // MusicArtistAlbum kind only — see FetchedItem for the source of these.
        public string Artist { get; set; } = string.Empty;
        public string AlbumArtist { get; set; } = string.Empty;
        public string Album { get; set; } = string.Empty;

        // PhotoAlbum kind only — see FetchedItem for the source of this.
        public string MediaFileUrl { get; set; } = string.Empty;

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

        /// <summary>StableIds the folder's collage was last built from — used to detect "top-4 changed" without rebuilding every sync tick.</summary>
        public List<string> LastCollageStableIds { get; set; } = new List<string>();
    }
}