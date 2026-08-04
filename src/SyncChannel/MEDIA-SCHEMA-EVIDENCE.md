# Emby channel media mapping evidence

This records what the schema mapper may safely promise, separated by evidence
strength. The live observations were made against Emby 4.10.0.22.

## Confirmed

- A movie is a media channel item with video media type and movie content
  type. Provider IDs are copied to the resulting item for Emby's normal
  metadata-provider behaviour.
- A usable show requires `Series -> Season -> Episode`. The source row owns
  Series metadata and provider IDs; playable media belongs to the Episode.
  Playing the Series or Season selects the available Episode.
- A photo collection requires `PhotoAlbum -> Photo`. The full image is the
  Photo media path, not the album poster. Emby supplies slideshow actions and
  plays multiple Photo children correctly.
- A standalone Photo is not a generic information card. It receives slideshow
  semantics and can construct surprising queues. The old DisplayCard shape is
  retained only for compatibility and is labelled unsupported in the editor.
- Generic Video, Movie, HLS and Audio sources all played successfully.
- Persisting an unprobed remote `MediaSourceInfo` can fail first playback:
  Emby runs FFProbe but returns `NoCompatibleStream` to that same request. A
  later request succeeds using the cached probe result.
- Supplying video/audio through `IRequiresMediaInfoCallback` plays on the first
  attempt. Technical stream details may appear only after probing/playback.
  Mapped video/audio therefore use the callback. Photo remains persisted
  because Emby copies the source path while constructing the Photo item.
- Blank media mapping means the bundled Coming Soon MP4 for video. Audio has
  no MP4 fallback and requires a mapped audio source. Photo requires an image,
  with poster URL as a defensive fallback where an API has one image concept.
- Emby may inherit or generate folder artwork from children.

## Strongly indicated, not guaranteed

- TMDB/TVDB IDs plus matching Movie/Series types appear to help Emby's normal
  metadata fetching. The plugin supplies those facts but cannot direct or
  guarantee which provider Emby uses.
- Audio probing can replace mapped artist/album values with tags from the
  source. Tagged audio is therefore likely to retain associations more
  reliably. The schema values are reapplied whenever the channel synchronizes.
- URL extensions usually provide useful container hints. Extensionless and
  signed endpoints still depend on Emby's probe.

## Needs more information

- Whether Emby exposes a supported channel mechanism to lock mapped artist,
  album-artist and album values against FFProbe/tag refresh.
- Whether Album/Artist associations can be fully navigable without genuine
  layered source rows. The synthetic one-row Artist/Album/Track experiment
  produced incomplete associations and is not a recommended destination.
- Layer mining (artists, then albums, then tracks) is not implemented. Current
  audio support is one playable track per fetched row with optional artist and
  album metadata on that track.
- Authentication headers, expiring URLs, DRM, and custom live-stream
  open/close lifecycles require targeted testing before being advertised.

## Implemented presentation contracts

- Movies: each row becomes a Movie.
- Shows with Coming Soon episode: each row becomes a Series with generated
  Season 1 and Episode; row media belongs to that generated Episode.
- Playable items as episodes: rows are grouped by mapped Show identity and
  Season number; each row becomes an Episode. Provider IDs are independently
  scoped to Series, Season and row Episode.
- Videos and Audio tracks: each row is the directly playable item.
- Photo collection: the fetch becomes one PhotoAlbum named from the fetch;
  every row becomes a Photo inside it.
- Music catalogue (experimental): track rows are grouped by mapped Artist and
  Album identities. Artist, Album and Track provider IDs are independently
  scoped. Emby's quality of library associations remains under test.
- Advanced nested media retains explicit folder-depth and leaf settings.

The low-level Emby object/media enums are internal except for the genuinely
variable Video style and Advanced nested-media leaf.
