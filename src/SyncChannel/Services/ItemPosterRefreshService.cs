// Bypasses ChannelManager.GetChannelItemEntity's own image-update guard
// (`!baseItem.HasImage(ImageType.Primary)` — confirmed via ILSpy), which
// means once a channel item has any Primary image, ChannelManager itself
// will never call SetImage again for that item via ChannelItemInfo.ImageUrl,
// correct or not. See Evidence.md.
//
// This service finds the BaseItem directly by ExternalId and force-applies
// a changed poster URL, working around that guard. BaseItem.SetImage itself
// is not gated — it always overwrites — the guard lives entirely in
// ChannelManager's caller code.
//
// Not needed for Photo BaseItems (ObjectKind.DisplayCard) — ChannelManager
// sets Photo.Path unconditionally from ChannelItemInfo.MediaSources on every
// sync, with no HasImage guard, so DisplayCard items already self-correct
// without this service. Wired up in FolderTreeSyncTask for every other
// ObjectKind (FlatMedia, Series, MusicArtistAlbum, PhotoAlbum,
// GenericContainer's level-0 folder) via
// SyncFolderChannel.BuildImageBearingExternalId, the single source of truth
// for each kind's id shape.
namespace SyncChannel.Services
{
    using MediaBrowser.Controller.Entities;
    using MediaBrowser.Controller.Library;
    using MediaBrowser.Model.Entities;
    using MediaBrowser.Model.Logging;
    using System;
    using System.Linq;

    public class ItemPosterRefreshService
    {
        private readonly ILibraryManager libraryManager;
        private readonly ILogger logger;

        public ItemPosterRefreshService(ILibraryManager libraryManager, ILogger logger)
        {
            this.libraryManager = libraryManager;
            this.logger = logger;
        }

        public void RefreshIfChanged(string externalId, string posterUrl)
        {
            if (string.IsNullOrEmpty(externalId) || string.IsNullOrEmpty(posterUrl))
            {
                return;
            }

            var item = libraryManager.GetItemsResult(new InternalItemsQuery
            {
                ExternalId = externalId
            }).Items.FirstOrDefault();

            if (item == null)
            {
                // Expected on first sync before Emby has persisted the item yet.
                return;
            }

            var currentPath = item.GetImagePath(ImageType.Primary);
            if (string.Equals(currentPath, posterUrl, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            try
            {
                item.SetImage(new ItemImageInfo
                {
                    Path = posterUrl,
                    Type = ImageType.Primary,
                    DateModified = DateTimeOffset.UtcNow
                }, 0);

                libraryManager.UpdateImages(item);

                logger.Info(
                    "ChannelSync: Poster refreshed for ExternalId='{0}' — '{1}' -> '{2}'.",
                    externalId, currentPath ?? "(none)", posterUrl);
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Failed to refresh poster for ExternalId='{0}'", ex, externalId);
            }
        }
    }
}