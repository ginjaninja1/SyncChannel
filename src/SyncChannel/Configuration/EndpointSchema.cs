// The generalization that lets a brand-new REST source (Sonarr, or anything
// else) be supported as data, not code. An EndpointSchema names one HTTP GET
// path plus how to read identity/display fields, which fields the rule
// builder is allowed to filter on, and which Emby channel-object shape the
// resulting items become. Radarr and Sonarr ship as two seeded EndpointSchema
// rows (see EndpointSchemaStore.SeedBuiltIns) rather than as their own
// IFetchProvider classes — HttpFetchProvider is generic against any schema.
//
// Every output field (Identity, Title, Poster, ProviderIds, etc.) is a
// FieldMapping — an ordered tree of MappingNodes built from JSON fields,
// literal text, or connection facts (base URL, api key name/value, the
// item's own already-resolved identity). This replaced a previous design
// where each field was a single plain dotted JsonPath string, plus two
// bespoke {value}/{identity}/{baseUrl}/{apikey} template strings for Poster
// and MediaFileUrl only. That older shape is fully retired, not kept as a
// fallback — this is a pre-release plugin; EndpointSchemaStore wipes and
// reseeds built-ins on every load rather than migrating old data (see
// EndpointSchemaStore.Load).
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

    // User-facing, deterministic transformations. Unlike ChannelObjectKind,
    // this states both what one response row means and how the complete fetch
    // result is presented. ChannelObjectKind remains an internal construction
    // detail while the pre-release schema format is replaced.
    public enum PresentationProfile
    {
        Movies,
        ShowsWithComingSoonEpisode,
        PlayableItemsAsEpisodes,
        Videos,
        AudioTracks,
        MusicCatalogueExperimental,
        PhotoCollection,
        NestedMedia
    }

    // DisplayCard: a picture + name, nothing underneath, nothing to play.
    // Built as Type=Media/MediaType=Video/ContentType=Trailer (see
    // SyncFolderChannel.BuildDisplayCardItem), which Emby's ChannelManager
    // construction switch maps to a real Photo BaseItem. For endpoints
    // whose items are genuinely just browsable facts — e.g. an artist list
    // where the artist itself isn't playable and has no meaningful
    // children in this plugin's model.

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
        // Same path grammar RuleEvaluator already walks — unchanged. This is
        // the rule-builder FILTER palette (conditions), separate from the
        // OUTPUT field mappings below — a field can be filtered on without
        // ever being mapped to Title/Poster/etc, and vice versa.
        public string JsonPath { get; set; } = string.Empty;

        public string DisplayName { get; set; } = string.Empty;

        public SchemaFieldType Type { get; set; } = SchemaFieldType.String;

        // Transport-only overlay, not the source of truth — FieldFavoritesStore
        // is. Stamped onto each field by ChannelSyncApiSurface at read time.
        public bool IsFavorite { get; set; }

        // Sample values seen for this path during discovery, one entry per
        // source record (first 3 records), in that record's own document
        // order — shown next to the field in the mapper UI so an admin can
        // tell what it actually contains without opening the raw response.
        // Examples[i] is that record's own value(s) for this path (empty
        // list if the record doesn't have it) — NOT a flattened/deduped
        // pool across records, so per-record preview and Array[N] indexing
        // stay aligned to the record they came from.
        public List<List<string>> Examples { get; set; } = new List<List<string>>();
    }

    // One node of a FieldMapping's tree. A mapping is an ordered
    // concatenation of top-level nodes — e.g. [CustomText "{baseUrl}/Items/",
    // Field "id", CustomText "/Images/Primary?tag=", Field "imageTags.primary",
    // CustomText "&api_key=", ApiKeyValue] resolves to a single URL string
    // per item. Kind=Function is a container node instead of a leaf: it
    // wraps one or more Children and applies a string/array operation to
    // their concatenated resolved output, which is what lets combinations
    // like Left[2][dateField] + "--" + Right[4][otherField] nest and sit
    // side-by-side within one mapping.
    public enum MappingNodeKind
    {
        // Value holds a dotted JsonPath, resolved per-item the same way
        // SchemaField.JsonPath is (via RuleEvaluator.ResolveDisplayValue).
        Field,

        // Value is the literal text, used as-is, e.g. "?tag=" or "&".
        CustomText,

        // No Value needed — resolves to Connection.ApiKeyParamName at fetch
        // time (e.g. "apikey" or "api_key").
        ApiKeyName,

        // No Value needed — resolves to Connection.ApiKey at fetch time.
        ApiKeyValue,

        // No Value needed — resolves to Connection.BaseUrl (trimmed of a
        // trailing slash) at fetch time.
        BaseUrl,

        // No Value needed — resolves to this item's already-resolved
        // IdentityField mapping output. Only meaningful on mappings OTHER
        // than IdentityField itself (a self-reference inside IdentityField
        // resolves to empty, since identity hasn't been produced yet when
        // IdentityField is the mapping being resolved).
        Identity,

        // Container node — see FunctionKind and Children below. Value/Start/
        // End on a Function node are interpreted per FunctionKind; Value is
        // unused.
        Function
    }

    public enum FunctionKind { Left, Right, Substring, ArraySlice }

    public class MappingNode
    {
        public MappingNodeKind Kind { get; set; } = MappingNodeKind.CustomText;

        // Field path (Kind=Field) or literal text (Kind=CustomText). Unused
        // for every other kind, including Function.
        public string Value { get; set; } = string.Empty;

        // Only meaningful for Kind=Function.
        public FunctionKind Function { get; set; }

        // Left/Right: character count (Start only, End ignored).
        // Substring/ArraySlice: inclusive start/end. ArraySlice End=-1
        // means "all". When ArrayMatchField is populated, ArraySlice instead
        // selects the first object whose sibling field equals ArrayMatchValue;
        // Start/End are ignored in that mode.
        public int Start { get; set; }
        public int End { get; set; } = -1;

        // ArraySlice's field=value mode. The wrapped Field supplies the value
        // path (for example images.remoteUrl); this field is resolved relative
        // to the same array item (for example coverType) before projecting the
        // wrapped value. Empty means the normal index/range/all modes.
        public string ArrayMatchField { get; set; } = string.Empty;
        public string ArrayMatchValue { get; set; } = string.Empty;

        // Only populated for Kind=Function — the node(s) this function
        // wraps. A Function with one child is the common case (e.g. Left[4]
        // wrapping a single date field); more than one child means the
        // function applies to their concatenated resolved text.
        public List<MappingNode> Children { get; set; } = new List<MappingNode>();
    }

    // An orderable, admin-built recipe for one output field. Empty
    // (no segments) is a valid, common state — it just means that field is
    // left unmapped and resolves to blank/null.
    public class FieldMapping
    {
        public List<MappingNode> Segments { get; set; } = new List<MappingNode>();
    }

    public class EndpointSchema
    {
        public string Id { get; set; } = Guid.NewGuid().ToString("N");

        public string DisplayName { get; set; } = string.Empty;

        // Strict ownership: every schema belongs to exactly one configured
        // connection. Its system type, URL and credentials are derived from
        // that connection rather than repeated here.
        public string ConnectionId { get; set; } = string.Empty;

        // Marks built-in seeds so the UI can label them "built-in" (locked,
        // 🔒 glyph — same treatment as built-in RuleSets) and the store can
        // re-seed them if ever deleted. Not otherwise treated specially by
        // fetch/evaluation code — a user-authored schema works identically.
        public bool IsBuiltIn { get; set; }

        public PresentationProfile Presentation { get; set; } = PresentationProfile.Movies;

        // Internal Emby construction settings. These are derived from
        // Presentation by the editor/built-ins and are not user-facing.
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
        // root IS the array — unchanged default behavior. A property of
        // the test/discovery result, not an independent setting — the UI
        // surfaces this immediately after a Test run, not before.
        public string ItemsRootPath { get; set; } = string.Empty;

        // Additional static query-string parameters always appended, e.g.
        // Limit=25. Plain literal strings, not field mappings — for
        // anything that should reflect a fetched value, use the role
        // fields or ProviderIdFields instead. Deliberately query-string
        // based rather than custom headers, per explicit preference:
        // fields are more visible/obvious in the schema editor than a
        // hidden header would be.
        public Dictionary<string, string> StaticQueryParams { get; set; } = new Dictionary<string, string>();

        // Every field below is a FieldMapping: an ordered recipe built from
        // JSON fields, literal text, and connection facts (see
        // MappingNodeKind). IdentityField is the only one that MUST
        // resolve non-empty — same "no stable id, drop the item" discipline
        // as before.
        public FieldMapping IdentityField { get; set; } = new FieldMapping();
        public FieldMapping TitleField { get; set; } = new FieldMapping();
        public FieldMapping OriginalTitleField { get; set; } = new FieldMapping();
        public FieldMapping YearField { get; set; } = new FieldMapping();
        public FieldMapping OverviewField { get; set; } = new FieldMapping();

        // Resolves straight to the finished image URL — for sources that
        // hand back a ready-to-use link, this is just a single Field
        // segment. For sources that only expose an opaque tag/id (e.g.
        // Emby's own API), build the full URL here using BaseUrl/Identity/
        // ApiKeyName/ApiKeyValue segments alongside the Field segment. This
        // replaces the old separate PosterUrlField + PosterUrlTemplate
        // pair — there is no template string anymore, the mapping IS the
        // template.
        public FieldMapping PosterUrlField { get; set; } = new FieldMapping();

        // MusicArtistAlbum only — resolved onto the Audio leaf's
        // IHasArtist/IHasAlbumArtist/IHasMusicAlbum interfaces in
        // GetChannelItemEntity (confirmed via ILSpy — these are read
        // directly off ChannelItemInfo.Artists/AlbumArtists/Album
        // independent of the parent folder's actual runtime type).
        public FieldMapping ArtistField { get; set; } = new FieldMapping();
        public FieldMapping AlbumArtistField { get; set; } = new FieldMapping();
        public FieldMapping AlbumField { get; set; } = new FieldMapping();
        public FieldMapping CatalogueArtistField { get; set; } = new FieldMapping();

        // Grouping/metadata for profiles where one row is below a Series.
        // PlayableItemsAsEpisodes requires ShowIdentity + ShowTitle; rows are
        // grouped by ShowIdentity, then by SeasonNumber (default 1).
        public FieldMapping ShowIdentityField { get; set; } = new FieldMapping();
        public FieldMapping ShowTitleField { get; set; } = new FieldMapping();
        public FieldMapping ShowOverviewField { get; set; } = new FieldMapping();
        public FieldMapping ShowPosterUrlField { get; set; } = new FieldMapping();
        public FieldMapping SeasonNumberField { get; set; } = new FieldMapping();
        public FieldMapping SeasonTitleField { get; set; } = new FieldMapping();
        public FieldMapping EpisodeNumberField { get; set; } = new FieldMapping();

        // Stable grouping keys for the experimental row-is-track catalogue.
        public FieldMapping ArtistIdentityField { get; set; } = new FieldMapping();
        public FieldMapping AlbumIdentityField { get; set; } = new FieldMapping();

        // The actual playable/viewable media URL or local path, distinct
        // from PosterUrlField (thumbnail/cover artwork). Video/audio use
        // IRequiresMediaInfoCallback so an unprobed remote source can play
        // on its first attempt; Photo requires a persisted MediaSourceInfo
        // because Emby copies its Path while constructing the Photo item.
        // Blank means "use the bundled coming-soon video" for video
        // destinations. Audio destinations require a real mapped source.
        public FieldMapping MediaFileUrlField { get; set; } = new FieldMapping();

        // Extra dotted paths, beyond the display fields above, surfaced as
        // ProviderIds on the resulting channel item — e.g. Radarr's tmdbId
        // and imdbId, which Emby's own UI recognises under "Tmdb"/"Imdb".
        // Composable the same way as every other field, so a built-in
        // schema populates these through the identical mechanism a
        // custom schema would, rather than a privileged shortcut.
        public Dictionary<string, FieldMapping> ProviderIdFields { get; set; } = new Dictionary<string, FieldMapping>();

        // Provider IDs are scoped to the object they identify. Item is the
        // row-level Movie/Video/Track/Photo/Episode. Series/Season/Artist/
        // Album apply only when the selected presentation creates them.
        public Dictionary<string, FieldMapping> SeriesProviderIdFields { get; set; } = new Dictionary<string, FieldMapping>();
        public Dictionary<string, FieldMapping> SeasonProviderIdFields { get; set; } = new Dictionary<string, FieldMapping>();
        public Dictionary<string, FieldMapping> ArtistProviderIdFields { get; set; } = new Dictionary<string, FieldMapping>();
        public Dictionary<string, FieldMapping> AlbumProviderIdFields { get; set; } = new Dictionary<string, FieldMapping>();

        // Provider-id keys (from ProviderIdFields, above) opted in to get a
        // clickable badge in Emby's edit-metadata UI. Backed by a fixed pool
        // of 5 pre-compiled GenericProviderIdExternalId slot classes (see
        // Providers/ProviderIdBadgeRegistry.cs) — Emby's IExternalId list is
        // composed once at startup, so a 6th badge needs a 6th compiled
        // class and a restart, not just flipping this toggle.
        public List<string> BadgeEnabledProviderIdKeys { get; set; } = new List<string>();

        // Optional per-key URL template, e.g. "https://thetvdb.com/movies/{0}".
        // {0} is substituted with whatever ProviderIdFields[key] resolved to
        // for that item — same single-substitution constraint Emby's own
        // ProviderManager.GetExternalUrls has (confirmed via ILSpy: one
        // value in, one Url out, no per-item override of the template
        // itself). Defaults to "{0}" (pass-through) when a key has no entry
        // here — the same behavior RadarrId/SonarrId already rely on, where
        // the field itself is built to already resolve to the complete,
        // connection-correct URL rather than a bare id. Only set a real
        // template here for a key whose target URL shape is genuinely fixed
        // regardless of which connection produced the item (e.g. a public
        // site like TheTVDB) — for anything that varies by connection (like
        // Radarr/Sonarr's own host:port), build the full URL into the field
        // mapping instead and leave this blank.
        public Dictionary<string, string> ProviderIdBadgeUrlFormats { get; set; } = new Dictionary<string, string>();

        // The fields available in the rule builder's FILTER palette for
        // this schema. Unrelated to the output FieldMappings above — see
        // SchemaField.JsonPath comment.
        public List<SchemaField> Fields { get; set; } = new List<SchemaField>();

    }

    public class EndpointSchemasFile
    {
        public List<EndpointSchema> Schemas { get; set; } = new List<EndpointSchema>();
    }
}
