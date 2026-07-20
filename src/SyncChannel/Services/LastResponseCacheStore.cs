// Replaces the old single hardcoded radarr-last-response.json with one file
// per (connection, schema) pair, so live rule preview works for any fetch
// combination, not just "the one Radarr connection."
namespace SyncChannel.Services
{
    using MediaBrowser.Common.Configuration;
    using MediaBrowser.Model.Logging;
    using System;
    using System.IO;

    public class LastResponseCacheStore
    {
        private readonly IApplicationPaths appPaths;
        private readonly ILogger logger;

        public LastResponseCacheStore(IApplicationPaths appPaths, ILogger logger)
        {
            this.appPaths = appPaths;
            this.logger = logger;
        }

        private string PathFor(string connectionId, string schemaId) =>
            Path.Combine(appPaths.DataPath, "channel-sync", "last-response", connectionId + "_" + schemaId + ".json");

        public string Read(string connectionId, string schemaId)
        {
            var path = PathFor(connectionId, schemaId);
            return File.Exists(path) ? File.ReadAllText(path) : "[]";
        }

        public void Write(string connectionId, string schemaId, string rawJson)
        {
            try
            {
                var path = PathFor(connectionId, schemaId);
                var dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                    Directory.CreateDirectory(dir);

                File.WriteAllText(path, rawJson);
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Failed to write last-response snapshot for {0}/{1}", ex, connectionId, schemaId);
            }
        }
    }
}