
using MediaBrowser.Common;
using MediaBrowser.Model.Logging;
using SyncChannel.UI.Config;
using SyncChannel.UIBaseClasses.Store;

namespace SyncChannel.Storage
{
    public class BasicsOptionsStore : SimpleFileStore<ConfigUI>
    {
        public BasicsOptionsStore(IApplicationHost applicationHost, ILogger logger, string pluginFullName)
        : base(applicationHost, logger, pluginFullName)
        {
        }
    }
}
