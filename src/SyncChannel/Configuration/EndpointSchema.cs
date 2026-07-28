// The generalization that lets a brand-new REST source (Sonarr, or anything
// else) be supported as data, not code. An EndpointSchema names one HTTP GET
// path plus how to read identity/display fields, which fields the rule
// builder is allowed to filter on, and — as of this version — which Emby
// channel-object shape the resulting items become. Radarr and Sonarr ship
// as two seeded EndpointSchema rows (see EndpointSchemaStore.SeedBuiltIns)
// rather than as their own IFetchProvider classes — HttpFetchProvider is
// generic against any schema.
namespace SyncChannel.Configuration
{
    using System;
    using System.Collections.Generic;

    public enum SchemaFieldType { String, Number, Bool, List, Date }

    // Which Emby channel-object shape this schema's items become. Each kind
    // maps to a confirmed-via-ILSpy-and-live-test construction path in
    // Emby's ChannelManager.GetChannelItemEntity — see Evidence.md. No
    // implicit default — every schema, built-in or user-authored, states
    // this explicitly, since guessing wrong here is exactly what caused
    // Sonarr items to be misidentified as movies.
    //
    //   FlatMedia       -> single playable ChannelItemInfo (Type=Media).
    //                      LeafMediaType/LeafContentType pick the exact
    //                      Emby BaseItem (Movie, or any standalone clip/
    //                      trailer/podcast/extra type). No container.
    //
    //   Series          -> ChannelFolderType.Series real container, with a
    //                      synthesized Season 1 / Episode 1 underneath
    //                      pointing at the shared stub video. Existing
    //                      behavior, unchanged.
    //
    //   MusicArtistAlbum -> two synthetic Folder-typed containers (Emby
    //                      does NOT construct real MusicArtist/MusicAlbum
    //                      classes for these FolderTypes — confirmed via
    //                      ILSpy: they fall through to plain Folder, same
    //                      as Container) with an Audio leaf underneath.
    //                      Artist/Album tagging still applies correctly to
    //                      the leaf via ArtistField/AlbumArtistField/
    //                      AlbumField, independent of the parent's actual
    //                      runtime type.
    //
    //   PhotoAlbum      -> ChannelFolderType.PhotoAlbum real container
    //                      (Emby DOES construct a real PhotoAlbum class for
    //                      this one) with a single level of Photo leaves
    //                      underneath — no synthetic middle layer needed.
    //                      Leaf uses MediaType=Video, ContentType=Trailer;
    //                      confirmed via live test (see Evidence.md) that
    //                      this specific, semantically-odd combination is
    //                      what Emby's construction switch actually maps to
    //                      a Photo object — do not "fix" this back to
    //                      something that looks more sensible.
    //
    //   GenericContainer -> ContainerLevelCount synthetic Container-typed
    //                      folders (no real BaseItem subclass, no metadata
    //                      scraping — same as admin folder-tree nodes today)
    //                      with a single configurable leaf underneath. The
    //                      fallback shape for anything that isn't Movie/TV/
    //                      Music/Photo-like.
    public enum ChannelObjectKind { FlatMedia, Series, MusicArtistAlbum, PhotoAlbum, GenericContainer, DisplayCard }

    // DisplayCard: a picture + name, nothing underneath, nothing to play.
    // Built as an empty Container folder (see SyncFolderChannel) rather
    // than a Media item with no working source. For endpoints whose items
    // are genuinely just browsable facts — e.g. an artist list where the
    // artist itself isn't playable and has no meaningful children in this
    // plugin's model.

    // Mirrors MediaBrowser.Model.Channels.ChannelMediaType. Only Video and
    // Audio are meaningful choices for a schema-authored leaf today — Photo
    // as a MediaType exists but is NOT how Emby actually constructs Photo
    // objects (see PhotoAlbum kind above), so it's deliberately not offered
    // as a leaf-media-type choice to avoid re-introducing that confusion.
    public enum LeafMediaType { Video, Audio }

    // Mirrors MediaBrowser.Model.Channels.ChannelMediaContentType exactly
    // (confirmed via ILSpy — full enum, all 10 members). Only the subset
    // that pairs sensibly with LeafMediaType.Video is offered per-kind by
    // the UI; stored as the full enum here so the mapping stays data, not
    // code, if Emby's construction switch is ever revisited.
    public enum LeafContentType
    {
        Clip, Podcast, Trailer, Movie, Episode, Song,
        MovieExtra, TvExtra, GameExtra, MusicVideo
    }

    public class SchemaField
    {
        // Dotted JSON path into each array element, e.g. "ratings.imdb.value".
        // Same path grammar RuleEvaluator already walks — unchanged.
        public string JsonPath { get; set; } = string.Empty;

        public string DisplayName { get; set; } = string.Empty;

        public SchemaFieldType Type { get; set; } = SchemaFieldType.String;

        // Transport-only overlay, not the source of truth — FieldFavoritesStore
        // is. Stamped onto each field by ChannelSyncApiSurface at read time.
        public bool IsFavorite { get; set; }

        // Up to 3 distinct, non-empty sample values seen for this path
        // during discovery — shown next to the field in the mapper UI so an
        // admin can tell what it actually contains without opening the raw
        // response.
        public List<string> Examples { get; set; } = new List<string>();
    }

    public class EndpointSchema
    {
        public string Id { get; set; } = Guid.NewGuid().ToString("N");

        public string DisplayName { get; set; } = string.Empty;

        // "radarr", "sonarr", etc. — must match ConnectionEntry.SystemType
        // for a Fetch to be allowed to pair them. A user-authored schema
        // declares its own value here (free text) rather than picking from a
        // fixed enum, so a new self-hosted *arr-family app doesn't require a
        // code change.
        public string SystemType { get; set; } = string.Empty;

        // Marks built-in seeds so the UI can label them "built-in" (locked,
        // 🔒 glyph — same treatment as built-in RuleSets) and the store can
        // re-seed them if ever deleted. Not otherwise treated specially by
        // fetch/evaluation code — a user-authored schema works identically.
        public bool IsBuiltIn { get; set; }

        // Which Emby channel object this schema's items become. See
        // ChannelObjectKind above.
        public ChannelObjectKind ObjectKind { get; set; }

        // FlatMedia / MusicArtistAlbum's leaf / GenericContainer's leaf only.
        // Ignored for Series (fixed Video/Episode by construction) and
        // PhotoAlbum (fixed Video/Trailer by construction — see comment on
        // ChannelObjectKind.PhotoAlbum).
        public LeafMediaType LeafMediaType { get; set; } = LeafMediaType.Video;
        public LeafContentType LeafContentType { get; set; } = LeafContentType.Movie;

        // GenericContainer only — how many synthetic Container-typed folder
        // levels sit between the schema's own item and its playable leaf.
        // 0 is valid (flat list of playable leaves grouped only by whatever
        // admin folder tree they're placed under). Purely cosmetic labels
        // for each level (e.g. "Show", "Collection") — Container has no
        // real sub-typing in Emby, so these are display names only, not
        // separate FolderTypes.
        public int ContainerLevelCount { get; set; }
        public List<string> ContainerLevelNames { get; set; } = new List<string>();

        // Appended to Connection.BaseUrl, e.g. "/api/v3/movie".
        public string Path { get; set; } = string.Empty;

        // Dotted path to the array within the response, for endpoints that
        // wrap it in an envelope object (e.g. Emby's {"Items": [...],
        // "TotalRecordCount": ...}) instead of returning a bare array at
        // the root (the Radarr/Sonarr shape). Blank means the response
        // root IS the array — unchanged default behavior.
        public string ItemsRootPath { get; set; } = string.Empty;

        // Replaces the old fixed AuthStyle enum, which was never actually
        // read by HttpFetchProvider (the query param name and X-Api-Key
        // header were hardcoded regardless of its value — confirmed dead
        // config). Not every API uses the same key parameter name — Emby
        // itself uses "api_key", not "apikey" — so this is schema-level,
        // explicit, and field-driven rather than a fixed style choice.
        public string ApiKeyParamName { get; set; } = "apikey";

        // Additional static query-string parameters always appended, e.g.
        // Limit=25. Plain literal strings, not field mappings — for
        // anything that should reflect a fetched value, use the role
        // fields or ProviderIdFields instead. Deliberately query-string
        // based rather than custom headers, per explicit preference:
        // fields are more visible/obvious in the schema editor than a
        // hidden header would be.
        public Dictionary<string, string> StaticQueryParams { get; set; } = new Dictionary<string, string>();

        // Dotted paths resolved against each array element to build a
        // FetchedItem generically. IdentityField is the only required one —
        // same "no stable id, drop the item" discipline as the old
        // TitleSlug-only rule (see Evidence.md).
        public string IdentityField { get; set; } = string.Empty;
        public string TitleField { get; set; } = string.Empty;
        public string OriginalTitleField { get; set; } = string.Empty;
        public string YearField { get; set; } = string.Empty;
        public string OverviewField { get; set; } = string.Empty;
        public string PosterUrlField { get; set; } = string.Empty;

        // MusicArtistAlbum only — resolved onto the Audio leaf's
        // IHasArtist/IHasAlbumArtist/IHasMusicAlbum interfaces in
        // GetChannelItemEntity (confirmed via ILSpy — these are read
        // directly off ChannelItemInfo.Artists/AlbumArtists/Album
        // independent of the parent folder's actual runtime type).
        public string ArtistField { get; set; } = string.Empty;
        public string AlbumArtistField { get; set; } = string.Empty;
        public string AlbumField { get; set; } = string.Empty;

        // PhotoAlbum only — the actual image file URL, distinct from
        // PosterUrlField (which is a thumbnail/cover, set via ImageUrl).
        // Confirmed via ILSpy: Photo.Path is set from
        // info.MediaSources.FirstOrDefault()?.Path, not from ImageUrl —
        // this field is what gets turned into that MediaSourceInfo.
        public string MediaFileUrlField { get; set; } = string.Empty;

        // Optional. Some sources (Radarr/Sonarr) give a full, ready-to-use
        // image URL directly — leave this blank and PosterUrlField's raw
        // value is used as-is. Others (Emby) only give an opaque tag/id
        // that must be assembled into a URL — e.g. Emby's actual image
        // location is "{baseUrl}/Items/{id}/Images/Primary?tag={tag}&api_
        // key={key}", never returned as a literal URL anywhere in its API.
        // When set, PosterUrlField's raw resolved value substitutes into
        // {value}; {identity} substitutes the resolved IdentityField value;
        // {baseUrl} and {apikey} come from the Connection.
        public string PosterUrlTemplate { get; set; } = string.Empty;

        // Same mechanism as PosterUrlTemplate, for MediaFileUrlField (PhotoAlbum kind).
        public string MediaFileUrlTemplate { get; set; } = string.Empty;

        // Extra dotted paths, beyond the display fields above, surfaced as
        // ProviderIds on the resulting channel item — e.g. Radarr's tmdbId
        // and imdbId, which Emby's own UI recognises under "Tmdb"/"Imdb".
        public Dictionary<string, string> ProviderIdFields { get; set; } = new Dictionary<string, string>();

        // The fields available in the rule builder's palette for this schema.
        public List<SchemaField> Fields { get; set; } = new List<SchemaField>();

        public string DetailUrlFormat { get; set; } = string.Empty; // e.g. "{baseUrl}/movie/{identity}"
    }

    public class EndpointSchemasFile
    {
        public List<EndpointSchema> Schemas { get; set; } = new List<EndpointSchema>();
    }
}